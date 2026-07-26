// Tests for CippService listMessageTrace outbound-payload SHAPE.
//
// The contract these lock down is verified against KelvinTegelaar/CIPP-API tag
// 10.7.0, Invoke-ListMessageTrace.ps1: a POST whose body CIPP maps onto
// Get-MessageTraceV2. The failure mode this suite exists to catch is the one
// this connector keeps re-fixing — sending fields CIPP does not read, or
// sending a field in a shape CIPP silently ignores (here: `status` must be
// { value }, and `subjectContains` must never reach CIPP at all).
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

function traceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    MessageTraceId: '00000000-0000-0000-0000-000000000000',
    Status: 'Delivered',
    Subject: 'Invoice attached',
    SenderAddress: 'billing@vendor.example',
    RecipientAddress: 'alice@contoso.com',
    Received: '2026-07-26 12:00:00Z',
    FromIP: '203.0.113.10',
    ToIP: '198.51.100.20',
    ...overrides,
  };
}

describe('CippService listMessageTrace', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = new CippService(
      { cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } },
      logger
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockFetch(payload: unknown) {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse(payload))
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('POSTs to /api/ListMessageTrace with tenantFilter in the body', async () => {
    const fetchMock = mockFetch([traceRow()]);

    await svc.listMessageTrace('contoso.com', { sender: 'billing@vendor.example' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/ListMessageTrace$/);
    expect(init.method).toBe('POST');
    // Nothing must ride in the query string — CIPP reads Body only.
    expect(url).not.toMatch(/\?/);
    const body = JSON.parse(init.body as string);
    expect(body.tenantFilter).toBe('contoso.com');
  });

  it('sends sender/recipient as plain strings (CIPP does `x.value ?? x`)', async () => {
    const fetchMock = mockFetch([traceRow()]);

    await svc.listMessageTrace('contoso.com', {
      sender: 'billing@vendor.example',
      recipient: 'alice@contoso.com',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.sender).toBe('billing@vendor.example');
    expect(body.recipient).toBe('alice@contoso.com');
  });

  it('wraps status as { value } — a bare string silently no-ops the CIPP filter', async () => {
    const fetchMock = mockFetch([traceRow()]);

    await svc.listMessageTrace('contoso.com', { status: 'Failed' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.status).toEqual({ value: 'Failed' });
  });

  it('passes days through and does not send startDate/endDate when days is set', async () => {
    const fetchMock = mockFetch([traceRow()]);

    await svc.listMessageTrace('contoso.com', {
      days: 7,
      startDate: '2026-07-01T00:00:00Z',
      endDate: '2026-07-26T00:00:00Z',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.days).toBe(7);
    expect(body.startDate).toBeUndefined();
    expect(body.endDate).toBeUndefined();
  });

  it('sends startDate/endDate verbatim when days is absent', async () => {
    const fetchMock = mockFetch([traceRow()]);

    await svc.listMessageTrace('contoso.com', {
      startDate: '2026-07-01T00:00:00Z',
      endDate: '1753488000',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.startDate).toBe('2026-07-01T00:00:00Z');
    expect(body.endDate).toBe('1753488000');
    expect(body.days).toBeUndefined();
  });

  it('messageId mode omits the date/status/IP filters CIPP ignores there', async () => {
    const fetchMock = mockFetch([traceRow()]);

    await svc.listMessageTrace('contoso.com', {
      messageId: '<abc@vendor.example>',
      days: 7,
      status: 'Delivered',
      fromIP: '203.0.113.10',
      toIP: '198.51.100.20',
      recipient: 'alice@contoso.com',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messageId).toBe('<abc@vendor.example>');
    expect(body.days).toBeUndefined();
    expect(body.status).toBeUndefined();
    expect(body.fromIP).toBeUndefined();
    expect(body.toIP).toBeUndefined();
    // recipient/sender still apply in messageId mode.
    expect(body.recipient).toBe('alice@contoso.com');
  });

  it('never sends subjectContains to CIPP and filters the result client-side', async () => {
    const fetchMock = mockFetch([
      traceRow({ Subject: 'Invoice attached' }),
      traceRow({ Subject: 'Lunch?' }),
      traceRow({ Subject: 'RE: invoice for July' }),
    ]);

    const rows = (await svc.listMessageTrace('contoso.com', {
      subjectContains: 'invoice',
    })) as Array<{ Subject: string }>;

    // Not in the outbound payload — CIPP has no server-side subject filter.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.subjectContains).toBeUndefined();

    // Applied client-side, case-insensitive.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.Subject)).toEqual(['Invoice attached', 'RE: invoice for July']);
  });

  it('returns the trace array unfiltered when subjectContains is absent', async () => {
    mockFetch([traceRow(), traceRow({ Subject: 'Lunch?' })]);

    const rows = (await svc.listMessageTrace('contoso.com', {})) as unknown[];
    expect(rows).toHaveLength(2);
  });
});
