const { Octokit } = require("@octokit/rest");
const { graphql } = require("@octokit/graphql");

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("Missing GITHUB_TOKEN");
  process.exit(1);
}

const octokit = new Octokit({ auth: TOKEN });
const graphqlWithAuth = graphql.defaults({ headers: { authorization: `token ${TOKEN}` } });

// Config from environment
const TARGET_OWNER = process.env.TARGET_OWNER;
const TARGET_REPO = process.env.TARGET_REPO;
const PR_AUTHOR = process.env.PR_AUTHOR;
const TITLE_REGEX = new RegExp(process.env.TITLE_REGEX);

async function listNotifications() {
  // List all notifications (default is unread only)
  const resp = await octokit.request("GET /notifications", {
    all: true,
    participating: false,
    per_page: 100,
  });
  return resp.data;
}

async function getPRFromNotification(notification) {
  const subj = notification.subject;
  if (!subj || subj.type !== "PullRequest") {
    return null;
  }
  if (!subj.url) {
    return null;
  }
  try {
    const prResp = await octokit.request("GET " + subj.url);
    return prResp.data;
  } catch (err) {
    console.warn("Could not fetch PR from subject URL:", subj.url, err.message);
    return null;
  }
}

async function fetchPRTimeline(owner, repo, prNumber) {
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          timelineItems(first: 100) {
            nodes {
              __typename
              ... on PullRequestAutoMergeEnabledEvent {
                actor { login }
              }
              ... on PullRequestMergedEvent {
                actor { login }
              }
              ... on PullRequestCommit {
                commit { oid }
              }
              ... on PullRequestReview {
                author { login }
                state
              }
              ... on IssueComment {
                author { login }
                body
              }
              ... on PullRequestReviewDismissedEvent {
                actor { login }
              }
              ... on PullRequestReviewThread {
                isResolved
              }
              // add any other event types you want to inspect
            }
          }
        }
      }
    }
  `;
  const resp = await graphqlWithAuth(query, {
    owner,
    repo,
    prNumber,
  });
  return resp.repository.pullRequest.timelineItems.nodes;
}

function isTimelineAllowed(nodes) {
  for (const ev of nodes) {
    switch (ev.__typename) {
      // allowed events
      case "PullRequestAutoMergeEnabledEvent":
      case "PullRequestMergedEvent":
      case "PullRequestCommit":
        break;
      // Other events should make the workflow get kept
      default:
        console.log("Disallowed event in timeline:", ev.__typename, ev);
        return false;
    }
  }
  return true;
}

async function markThreadDone(threadId) {
  await octokit.request("DELETE /notifications/threads/{thread_id}", {
    thread_id: threadId,
  });
  console.log(`Thread ${threadId} marked done.`);
}

async function processOne(notification) {
  const pr = await getPRFromNotification(notification);
  if (!pr) return;

  const { base, user, number: prNumber, title } = pr;
  const fullName = base?.repo?.full_name;
  if (!fullName) return;

  const [owner, repo] = fullName.split("/");
  if (owner !== TARGET_OWNER || repo !== TARGET_REPO) {
    return;
  }

  if (user.login !== PR_AUTHOR) {
    return;
  }

  if (!TITLE_REGEX.test(title)) {
    return;
  }

  // Fetch timeline events
  let timelineNodes = [];
  try {
    timelineNodes = await fetchPRTimeline(owner, repo, prNumber);
  } catch (err) {
    console.warn("Could not fetch timeline for PR", prNumber, err.message);
    return;
  }

  if (!isTimelineAllowed(timelineNodes)) {
    return;
  }

  console.log(`Notification thread ${notification.id} qualifies for dismissal (PR #${prNumber}, title=${title})`);
  try {
    await markThreadDone(notification.id);
  } catch (err) {
    console.error("Failed to mark thread done:", notification.id, err.message);
  }
}

async function main() {
  try {
    const notifs = await listNotifications();
    for (const nt of notifs) {
      await processOne(nt);
    }
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}

main();
