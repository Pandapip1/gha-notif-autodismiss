import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("Missing GITHUB_TOKEN");
  process.exit(1);
}

const ThrottledOctokit = Octokit.plugin(throttling);
const octokit = new ThrottledOctokit({
  auth: TOKEN,
  throttle: {
    onRateLimit: (retryAfter, options, octokit, retryCount) => {
      octokit.log.warn(
        `Request quota exhausted for request ${options.method} ${options.url}`,
      );

      if (retryCount < 1) {
        // only retries once
        octokit.log.info(`Retrying after ${retryAfter} seconds!`);
        return true;
      }
    },
    onSecondaryRateLimit: (retryAfter, options, octokit) => {
      // does not retry, only logs a warning
      octokit.log.warn(
        `SecondaryRateLimit detected for request ${options.method} ${options.url}`,
      );
    },
  },
});

// Config from environment
const TARGET_OWNER = process.env.TARGET_OWNER;
const TARGET_REPO = process.env.TARGET_REPO;

async function listNotifications() {
  return await octokit.paginate("GET /notifications", {
    all: false,
    participating: false,
    per_page: 100,
  });
}

async function getCheckRunFromNotification(notification) {
  const subj = notification.subject;
  console.log(`Notification ${notification.id} has type "${subj?.type}"`);
  if (!subj || subj.type !== "CheckSuite" && subj.type !== "CheckRun") {
    return null;
  }

  try {
    const resp0 = await octokit.request("GET " + notification.url);
    console.dir(resp0.data);
    return null;
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
  // Make sure it's in the target repo
  const repoFullName = notification.repository?.full_name;
  if (repoFullName !== `${TARGET_OWNER}/${TARGET_REPO}`) {
    console.log(`Notification ${notification.id} has repository "${notification.repository?.full_name}"`);
    return;
  }

  const checkData = await getCheckRunFromNotification(notification);
  if (!checkData) return;

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

    await Promise.allSettled(notifications.map(processOne));

    console.log("All notifications processed.");
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}

main();
