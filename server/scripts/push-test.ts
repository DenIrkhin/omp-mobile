// Sends one notification through APNs from this Mac, to check push without the app. Run from server/.
//   bun scripts/push-test.ts --fake-key
//     One request to the APNs sandbox signed with a new random key. APNs answers
//     403 InvalidProviderToken, which shows this Mac reaches APNs over HTTP/2.
//     Needs no config file and no Apple account.
//   bun scripts/push-test.ts --token <hex> [--env sandbox|production]
//     A test notification to that device token with the key in the config file.
import { loadConfigOrExit } from "../config";
import { ApnsClient, http2Transport, type PushEnvironment, testMessage } from "../push-apns";
import { deviceToken } from "../push-devices";

const USAGE = "Usage: bun scripts/push-test.ts --fake-key\n       bun scripts/push-test.ts --token <hex> [--env sandbox|production]";

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

const args = process.argv.slice(2);
const transport = http2Transport();

/** The client, environment and device token for the chosen mode. */
async function setUp(): Promise<{ client: ApnsClient; env: PushEnvironment; token: string }> {
  if (args.length === 1 && args[0] === "--fake-key") {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const client = new ApnsClient({
      teamId: "TEAM000000",
      bundleId: "io.github.example.ompmobile",
      keys: { sandbox: { keyId: "KEY0000000", path: "(generated)" }, production: null },
      transport: transport.send,
      loadKey: async () => pair.privateKey,
    });
    return { client, env: "sandbox", token: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex") };
  }
  if (args[0] !== "--token" || (args.length !== 2 && args.length !== 4) || (args.length === 4 && args[2] !== "--env")) usage();
  const token = deviceToken(args[1]) ?? usage();
  const env = args.length === 4 ? args[3] : "sandbox";
  if (env !== "sandbox" && env !== "production") usage();
  const config = loadConfigOrExit({ requireServer: false });
  if (config.push === null) {
    console.error("Push is off in the config file: set push.enabled, push.bundleId, push.teamId and a key in push.keys.");
    process.exit(1);
  }
  if (config.push.keys[env] === null) {
    console.error(`The config file has no push.keys.${env}.`);
    process.exit(1);
  }
  return { client: new ApnsClient({ ...config.push, transport: transport.send }), env, token };
}

const { client, env, token } = await setUp();
const result = await client.send(env, testMessage(token), Date.now());
transport.close();
console.log(`status ${result.status} ${result.reason ?? "ok"}`);
// --fake-key passes when APNs answered at all; a real send passes only with 200.
process.exit((args[0] === "--fake-key" ? result.status !== 0 : result.status === 200) ? 0 : 1);
