const { Octokit } = require("@octokit/rest");

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("Missing GITHUB_TOKEN");
  process.exit(1);
}

const octokit = new Octokit({ auth: TOKEN });

// Config from environment
const TARGET_OWNER = process.env.TARGET_OWNER;
const TARGET_REPO = process.env.TARGET_REPO;

async function listNotifications() {
  return await octokit.paginate("GET /notifications", {
    all: true,
    participating: false,
    per_page: 100,
  });
}

async function getCheckRunFromNotification(notification) {
  const subj = notification.subject;
  if (!subj || subj.type !== "CheckSuite" && subj.type !== "CheckRun") {
    return null;
  }

  if (!subj.url) {
    return null;
  }

  try {
    const resp = await octokit.request("GET " + subj.url);
    return resp.data;
  } catch (err) {
    console.warn("Could not fetch check data from subject URL:", subj.url, err.message);
    return null;
  }
}

async function markThreadDone(threadId) {
  await octokit.request("DELETE /notifications/threads/{thread_id}", {
    thread_id: threadId,
  });
  console.log(`Thread ${threadId} dismissed.`);
}

async function processOne(notification) {
  const checkData = await getCheckRunFromNotification(notification);
  if (!checkData) return;

  // Make sure it's in the target repo
  const repoFullName = checkData.repository?.full_name;
  if (repoFullName !== `${TARGET_OWNER}/${TARGET_REPO}`) return;

  // Look for canceled check runs with the "higher priority" message
  const conclusion = checkData.conclusion || checkData.status;
  const cancelMessage = "Canceling since a higher priority waiting request for update exists";

  if (conclusion === "cancelled") {
    if (checkData.output?.text?.includes(cancelMessage)) {
      console.log(`Dismissing notification ${notification.id} for canceled check run ${checkData.name}`);
      try {
        await markThreadDone(notification.id);
      } catch (err) {
        console.error("Failed to dismiss thread:", notification.id, err.message);
      }
    } else {
      console.log(`Notification ${notification.id} has other cancel message "${checkData.output?.text}"`);
    }
  }
}

async function main() {
  try {
    const notifications = await listNotifications();
    for (const nt of notifications) {
      await processOne(nt);
    }
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}

main();
