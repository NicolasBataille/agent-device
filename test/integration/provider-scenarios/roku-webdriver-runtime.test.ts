import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { test } from 'vitest';
import { CLOUD_WEBDRIVER_PROVIDERS } from '../../../src/cloud-webdriver/providers.ts';
import { createRokuWebDriverRuntime } from '../../../src/cloud-webdriver/roku.ts';
import type { DeviceLease } from '../../../src/daemon/lease-registry.ts';
import type { DaemonRequest } from '../../../src/daemon/types.ts';
import { createProviderDeviceRuntimeRequestProviders } from '../../../src/provider-device-runtime.ts';
import { assertRpcOk } from './assertions.ts';
import {
  CloudWebDriverTestServer,
  type CloudWebDriverHttpCall,
  startCloudWebDriverTestServer,
  type StartedCloudWebDriverTestServer,
  writeCloudWebDriverTestJson,
} from './cloud-webdriver-test-server.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';
import { runProviderScenario } from './scenario.ts';

const ROKU_DEVICE_IP = '127.0.0.1';
const ROKU_CHANNEL_ID = 'dev-channel';
const ROKU_SESSION_ID = 'roku-session-1';

test('Roku WebDriver runtime drives TV commands through daemon routes', async () => {
  await withProviderScenarioResource(createRokuWebDriverWorld, async ({ daemon, server }) => {
    const lease = await allocateRokuLease(daemon, server.url);

    await runProviderScenario(
      daemon,
      [
        {
          name: 'open',
          command: 'open',
          positionals: [ROKU_CHANNEL_ID],
        },
        {
          name: 'snapshot',
          command: 'snapshot',
          assert: (response) => {
            const data = assertRpcOk<{
              nodes?: Array<{ label?: string; identifier?: string; hittable?: boolean }>;
            }>(response);
            assert.equal(data.nodes?.[1]?.label, 'Play');
            assert.equal(data.nodes?.[1]?.identifier, 'play');
            assert.equal(data.nodes?.[1]?.hittable, true);
          },
        },
        {
          name: 'remote down',
          command: 'tv-remote',
          positionals: ['down'],
          expectData: {
            action: 'tv-remote',
            button: 'down',
            message: 'Pressed TV remote down',
          },
        },
        {
          name: 'close',
          command: 'close',
          positionals: [ROKU_CHANNEL_ID],
        },
      ],
      {
        flags: rokuCommandFlags(lease.leaseId),
        meta: rokuCommandMeta(lease.leaseId),
      },
    );

    assert.deepEqual(
      server.calls.map((call) => `${call.method} ${call.path}`),
      [
        'POST /v1/session',
        `POST /v1/session/${ROKU_SESSION_ID}/launch`,
        `GET /v1/session/${ROKU_SESSION_ID}/source`,
        'POST /keypress/Down',
        `POST /exit-app/${ROKU_CHANNEL_ID}/true`,
        `DELETE /v1/session/${ROKU_SESSION_ID}`,
      ],
    );
    assert.deepEqual(server.calls[0]?.body, { ip: ROKU_DEVICE_IP });
    assert.deepEqual(server.calls[1]?.body, { channelId: ROKU_CHANNEL_ID });
    for (const call of server.calls) {
      assert.equal(call.headers['x-agent-device-client'], 'agent-device-cli');
      assert.equal(typeof call.headers['x-agent-device-version'], 'string');
    }
  });
}, 15_000);

async function createRokuWebDriverWorld() {
  const server = await FakeRokuWebDriverServer.start();
  const runtime = createRokuWebDriverRuntime({
    ecpEndpoint: server.url,
  });
  const providers = createProviderDeviceRuntimeRequestProviders([runtime]);
  const daemon = await createProviderScenarioHarness({
    ...providers,
    deviceInventoryProvider: providers.deviceInventoryProvider!,
  });
  return {
    daemon,
    server,
    close: async () => {
      await runtime.shutdown();
      await daemon.close();
      await server.close();
    },
  };
}

async function allocateRokuLease(
  daemon: Awaited<ReturnType<typeof createProviderScenarioHarness>>,
  endpoint: string,
): Promise<DeviceLease> {
  const allocate = await daemon.callCommand(
    'lease_allocate',
    [],
    {
      ...rokuCommandFlags(),
      rokuWebDriverUrl: endpoint,
      rokuDeviceIp: ROKU_DEVICE_IP,
      providerApp: ROKU_CHANNEL_ID,
    },
    { meta: rokuCommandMeta() },
  );
  const data = assertRpcOk<{
    lease?: DeviceLease;
    provider?: {
      provider?: string;
      providerSessionId?: string;
      deviceId?: string;
      capabilities?: { operations?: { tvRemote?: { support?: string } } };
    };
  }>(allocate);
  assert.ok(data.lease);
  assert.equal(data.provider?.provider, CLOUD_WEBDRIVER_PROVIDERS.roku);
  assert.equal(data.provider?.providerSessionId, ROKU_SESSION_ID);
  assert.equal(data.provider?.deviceId, `roku:${ROKU_DEVICE_IP}`);
  assert.equal(data.provider?.capabilities?.operations?.tvRemote?.support, 'supported');
  return data.lease;
}

function rokuCommandFlags(leaseId?: string): DaemonRequest['flags'] {
  return {
    platform: 'web',
    target: 'tv',
    tenant: 'team-roku',
    runId: 'run-roku',
    leaseId,
    leaseProvider: CLOUD_WEBDRIVER_PROVIDERS.roku,
  };
}

function rokuCommandMeta(leaseId?: string): DaemonRequest['meta'] {
  return {
    tenantId: 'team-roku',
    runId: 'run-roku',
    leaseId,
    leaseBackend: 'web-instance',
    leaseProvider: CLOUD_WEBDRIVER_PROVIDERS.roku,
    deviceKey: `roku:${ROKU_DEVICE_IP}`,
    clientId: 'client-roku',
  };
}

class FakeRokuWebDriverServer extends CloudWebDriverTestServer {
  static async start(): Promise<StartedCloudWebDriverTestServer<FakeRokuWebDriverServer>> {
    return await startCloudWebDriverTestServer(new FakeRokuWebDriverServer());
  }

  protected respond(call: CloudWebDriverHttpCall, res: ServerResponse): void {
    switch (`${call.method} ${call.path}`) {
      case 'POST /v1/session':
        writeCloudWebDriverTestJson(res, {
          value: {
            sessionId: ROKU_SESSION_ID,
            vendor: 'Roku',
            model: 'Ultra',
          },
        });
        return;
      case `POST /v1/session/${ROKU_SESSION_ID}/launch`:
      case `DELETE /v1/session/${ROKU_SESSION_ID}`:
        writeCloudWebDriverTestJson(res, { value: null });
        return;
      case `GET /v1/session/${ROKU_SESSION_ID}/source`:
        writeCloudWebDriverTestJson(res, {
          value: Buffer.from(fakeRokuSource(), 'utf8').toString('base64'),
        });
        return;
      case 'POST /keypress/Down':
      case `POST /exit-app/${ROKU_CHANNEL_ID}/true`:
        res.writeHead(200);
        res.end();
        return;
      default:
        writeCloudWebDriverTestJson(res, { value: { message: 'unexpected route' } }, 404);
    }
  }
}

function fakeRokuSource(): string {
  return (
    '<hierarchy><node text="Root" bounds="[0,0][1280,720]" displayed="true">' +
    '<node text="Play" id="play" bounds="[100,120][220,180]" displayed="true" />' +
    '</node></hierarchy>'
  );
}
