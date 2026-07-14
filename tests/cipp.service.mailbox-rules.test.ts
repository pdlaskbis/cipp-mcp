import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';

const logger = new Logger('error');

function jsonResponse(payload: unknown): Response {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

describe('CippService mailbox rules queue resolution', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = new CippService(
      { cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } },
      logger
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('listMailboxRules re-reads until the queued cache populates', async () => {
    jest.useFakeTimers();
    const fetchMock = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValueOnce(
        jsonResponse({
          Metadata: {
            QueueMessage: 'Loading data for contoso.com. Please check back in 1 minute',
            QueueId: 'q1',
          },
          Results: [],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ Results: [{ ruleId: 'r1', ruleName: 'Move to RSS' }] })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = svc.listMailboxRules('contoso.com') as Promise<{ Results: unknown[] }>;
    await jest.advanceTimersByTimeAsync(12_000);
    const result = await promise;

    expect(result.Results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('listMailboxRules surfaces the queue message instead of a false empty', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(
        jsonResponse({
          Metadata: {
            QueueMessage: 'Loading data for contoso.com. Please check back in 1 minute',
            QueueId: 'q1',
          },
          Results: [],
        })
      )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = svc.listMailboxRules('contoso.com') as Promise<{
      Metadata?: { QueueMessage?: string };
      Results: unknown[];
    }>;
    await jest.advanceTimersByTimeAsync(30_000);
    const result = await promise;

    // Caller must be able to see "still building" - an empty Results with no
    // Metadata would read as "this mailbox has no rules", which is the bug.
    expect(result.Metadata?.QueueMessage).toMatch(/check back/i);
    expect(result.Results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3); // t=0, 12s, 24s - then 24+12 >= 30 deadline
  });
});
