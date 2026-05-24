import { fileURLToPath } from 'url';
import path from 'path';
import { SuiMaster, SuiLocalTestValidator } from 'suidouble';
import LocalnodeWalrusTestState from '../../seal_walrus_localnet/includes/LocalnodeWalrusTestState.js';
import LocalnodeWalrusTestServer from '../../seal_walrus_localnet/includes/LocalnodeWalrusTestServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOVE_PKG_PATH = path.join(__dirname, '../../endless_vector/move');

/**
 * Process-scoped cache — shared across all test files in the same vitest worker
 * (requires singleFork: true + isolate: false in vitest.config.js).
 *
 * @type {Promise<{ suiMaster, walrusState, walrusServer, walrusClient, packageId }> | null}
 */
let cached = null;
let exitHookInstalled = false;

function installExitHook() {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    process.once('beforeExit', async () => {
        try {
            const { walrusServer } = await cached;
            await walrusServer?.stop();
        } catch { /* best-effort */ }
        try { await SuiLocalTestValidator.stop(); } catch { /* best-effort */ }
    });
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.once(sig, () => {
            (cached ? cached.then(({ walrusServer }) => walrusServer?.stop()).catch(() => {}) : Promise.resolve())
                .then(() => SuiLocalTestValidator.stop())
                .finally(() => process.exit(0));
        });
    }
}

/**
 * Boot the local validator, deploy the endless_vector package, and start a
 * WalrusTestServer. Idempotent — the first call does the work, subsequent
 * calls return the same handles.
 *
 * @param {{ debug?: boolean }} [opts]
 */
export function setupLocalnet(opts = {}) {
    if (cached) return cached;
    installExitHook();
    cached = (async () => {
        const debug = !!opts.debug;
        const validator = await SuiLocalTestValidator.launch({ debug });
        if (!validator.active) throw new Error('local test validator failed to start');

        const suiMaster = new SuiMaster({ client: validator, as: 'wds_tester', debug });
        await suiMaster.initialize();
        await suiMaster.requestSuiFromFaucet();
        await suiMaster.requestSuiFromFaucet();
        await suiMaster.requestSuiFromFaucet();

        const walrusState = new LocalnodeWalrusTestState({
            suiMaster,
            packagePath: MOVE_PKG_PATH,
            epochDuration: 30_000,
        });
        await walrusState.deploy();

        const packageId = walrusState.walrusPackageId;

        const walrusServer = new LocalnodeWalrusTestServer({ state: walrusState });
        await walrusServer.start();

        const walrusClient = await walrusServer.getWalrusClient({ suiMaster });

        return { suiMaster, walrusState, walrusServer, walrusClient, packageId };
    })().catch((err) => {
        cached = null;
        throw err;
    });
    return cached;
}

/** No-op per-suite — cleanup is handled by the beforeExit hook. */
export async function teardownLocalnet() {
    // intentionally empty
}
