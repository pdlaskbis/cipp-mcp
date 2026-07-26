import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';

const logger = new Logger('error');

const USER_ID = '11111111-2222-3333-4444-555555555555';
const UPN = 'alice@contoso.com';
const TENANT = 'contoso.com';

function jsonResponse(payload: unknown): Response {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

function identityLookup(): Response {
  return jsonResponse([{ id: USER_ID, userPrincipalName: UPN }]);
}

/** Minimal well-formed CIPP BEC Results object; override buckets per test. */
function becResults(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    AddedApps: [],
    SuspectUserMailboxLogons: [],
    SuspectUserDevices: [],
    NewRules: [],
    InboxRuleChanges: [],
    SentMessages: [],
    MailboxPermissionChanges: [],
    NewUsers: [],
    MFADevices: [],
    ChangedPasswords: [],
    ExtractedAt: '2026-07-26T14:12:50.6638804+00:00',
    ExtractResult: 'Successfully extracted logs from auditlog',
    ...over,
  };
}

type BecResult = {
  status: string;
  verified: boolean;
  assessment: { severity: string; reasons: string[]; counts: Record<string, number> };
  alert: { severity: string; title: string } | null;
};

/** Drive becCheck to completion with the supplied Results payload. */
async function runWith(
  svc: CippService,
  results: unknown,
  options: Record<string, unknown> = {}
): Promise<BecResult> {
  jest.useFakeTimers();
  const fetchMock = jest
    .fn<Promise<Response>, [string, RequestInit]>()
    .mockResolvedValueOnce(identityLookup())
    .mockResolvedValueOnce(jsonResponse({ GUID: USER_ID }))
    .mockResolvedValueOnce(jsonResponse(results));
  global.fetch = fetchMock as unknown as typeof fetch;

  const promise = svc.becCheck(TENANT, UPN, {
    intervalMs: 1000,
    maxAttempts: 3,
    ...options,
  }) as Promise<BecResult>;
  await jest.advanceTimersByTimeAsync(4000);
  return promise;
}

describe('CippService becCheck — alert threshold', () => {
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

  it('stays quiet on routine background noise', async () => {
    // This is the load-bearing test. Failed sign-ins are password-spray noise
    // present in every tenant. A rule that fires on these fires on every run
    // forever, which is alert fatigue and fails the same way as no alerting.
    const result = await runWith(
      svc,
      becResults({
        SuspectUserMailboxLogons: [
          { Status: 'Failed', IPAddress: '176.110.216.6', userPrincipalName: 'bob@contoso.com' },
          { Status: 'Failed', IPAddress: '85.137.24.190', userPrincipalName: 'carol@contoso.com' },
        ],
        NewUsers: [{ displayName: 'Someone New' }],
        ChangedPasswords: [{ displayName: 'Someone Else' }],
      })
    );

    expect(result.assessment.severity).toBe('info');
    expect(result.alert).toBeNull();
    expect(result.verified).toBe(true); // ExtractResult reports success
  });

  it('flags a forwarding inbox rule as critical', async () => {
    const result = await runWith(
      svc,
      becResults({
        NewRules: [
          {
            Name: 'Silent forward',
            Enabled: true,
            ForwardTo: ['"Mallory" [SMTP:mallory@evil.example]'],
            DeleteMessage: false,
          },
        ],
      })
    );

    expect(result.assessment.severity).toBe('critical');
    expect(result.assessment.reasons.join(' ')).toMatch(/Silent forward.*forwards/);
    expect(result.alert?.severity).toBe('critical');
  });

  it('ignores a rule with no forward or delete action', async () => {
    const result = await runWith(
      svc,
      becResults({
        NewRules: [{ Name: 'Just categorise', Enabled: true, ApplyCategory: ['Blue'] }],
      })
    );

    expect(result.assessment.severity).toBe('info');
    expect(result.alert).toBeNull();
  });

  it('ignores Exchange NT SERVICE permission housekeeping but flags a real grant', async () => {
    const noise = await runWith(
      svc,
      becResults({
        MailboxPermissionChanges: [
          {
            Operation: 'Add-MailboxPermission',
            UserKey: 'NT SERVICE\\MSExchangeAdminApiNetCore',
            ObjectId: 'DiscoverySearchMailbox{D919BA05}',
            Permissions: 'FullAccess',
          },
        ],
      })
    );
    expect(noise.assessment.severity).toBe('info');

    const real = await runWith(
      svc,
      becResults({
        MailboxPermissionChanges: [
          {
            Operation: 'Add-MailboxPermission',
            UserKey: 'mallory@contoso.com',
            ObjectId: 'ceo',
            Permissions: 'FullAccess',
          },
        ],
      })
    );
    expect(real.assessment.severity).toBe('critical');
    expect(real.assessment.reasons.join(' ')).toMatch(/mallory@contoso\.com granted FullAccess/);
  });

  it('warns on a new app, and knownAppIds suppresses it', async () => {
    const payload = becResults({
      AddedApps: [
        { displayName: 'Acta', appId: '875135d0-6a7c-488b-a46f-51fa642b5491' },
      ],
    });

    const flagged = await runWith(svc, payload);
    expect(flagged.assessment.severity).toBe('warning');

    const suppressed = await runWith(svc, payload, {
      baseline: { knownAppIds: ['875135D0-6A7C-488B-A46F-51FA642B5491'] }, // case-insensitive
    });
    expect(suppressed.assessment.severity).toBe('info');
    expect(suppressed.alert).toBeNull();
  });

  it('warns on successful sign-ins from unknown IPs but never on failed ones', async () => {
    const payload = becResults({
      SuspectUserMailboxLogons: [
        { Status: 'Success', IPAddress: '173.22.99.39' },
        { Status: 'Failed', IPAddress: '45.9.249.58' },
      ],
    });

    const flagged = await runWith(svc, payload);
    expect(flagged.assessment.severity).toBe('warning');
    expect(flagged.assessment.reasons.join(' ')).toContain('173.22.99.39');
    expect(flagged.assessment.reasons.join(' ')).not.toContain('45.9.249.58');

    const suppressed = await runWith(svc, payload, {
      baseline: { knownIPs: ['173.22.99.39'] },
    });
    expect(suppressed.assessment.severity).toBe('info');
  });

  it('refuses to report verified when CIPP does not confirm the extract', async () => {
    const result = await runWith(
      svc,
      becResults({ ExtractResult: 'Partial failure reading auditlog' })
    );

    expect(result.status).toBe('complete');
    expect(result.verified).toBe(false);
  });
});
