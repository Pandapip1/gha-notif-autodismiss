const { Octokit } = require("@octokit/rest");
import { throttling } from "@octokit/plugin-throttling";

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("Missing GITHUB_TOKEN");
  process.exit(1);
}

const ThrottledOctokit = Octokit.plugin(throttling);
const octokit = new ThrottledOctokit({ auth: TOKEN });

// Config from environment
const TARGET_OWNER = process.env.TARGET_OWNER;
const TARGET_REPO = process.env.TARGET_REPO;
const PR_AUTHOR = process.env.PR_AUTHOR;
const TITLE_REGEX = new RegExp(process.env.TITLE_REGEX);

async function listNotifications() {
  return await octokit.paginate("GET /notifications", {
    all: true,
    participating: false,
    per_page: 100,
  });
}

async function getPRFromNotification(notification) {
  const { subject } = notification;
  if (!subject || subject.type !== "PullRequest" || !subject.url) return null;

  try {
    const prResp = await octokit.request("GET " + subject.url);
    return prResp.data;
  } catch (err) {
    console.warn("Could not fetch PR from subject URL:", subject.url, err.message);
    return null;
  }
}

async function fetchPRTimeline(owner, repo, prNumber) {
  const resp = await octokit.request(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline",
    { owner, repo, issue_number: prNumber }
  );
  return resp.data;
}

function isTimelineAllowed(events) {
  const allowed = new Set(["opened", "committed", "auto_merge_enabled", "merged", "closed", "head_ref_deleted"]);
  for (const ev of events) {
    if (!allowed.has(ev.event)) {
      console.log("Disallowed event in timeline:", ev.event, ev);
      return false;
    }
  }
  return true;
}

async function markThreadDone(threadId) {
  await octokit.request("DELETE /notifications/threads/{thread_id}", { thread_id: threadId });
  console.log(`Thread ${threadId} marked done.`);
}

async function processOne(notification) {
  const pr = await getPRFromNotification(notification);
  if (!pr) return;

  const { base, user, number: prNumber, title } = pr;
  const fullName = base?.repo?.full_name;
  if (!fullName) return;

  const [owner, repo] = fullName.split("/");
  if (owner !== TARGET_OWNER || repo !== TARGET_REPO) return;
  if (user.login !== PR_AUTHOR) return;
  if (!TITLE_REGEX.test(title)) return;

  let timelineEvents;
  try {
    timelineEvents = await fetchPRTimeline(owner, repo, prNumber);
  } catch (err) {
    console.warn("Could not fetch timeline for PR", prNumber, err.message);
    return;
  }

  if (!isTimelineAllowed(timelineEvents)) return;

  console.log(`Notification thread ${notification.id} qualifies for dismissal (PR #${prNumber}, title=${title})`);

  try {
    await markThreadDone(notification.id);
  } catch (err) {
    console.error("Failed to mark thread done:", notification.id, err.message);
  }
}

async function main() {
  try {
    const notifications = await listNotifications();

    // Process all notifications in parallel
    await Promise.allSettled(notifications.map(processOne));

    console.log("All notifications processed.");
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}

main();
