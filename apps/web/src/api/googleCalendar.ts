import { validateCalendarPayload, type CalendarAccount, type CalendarAction, type CalendarAdapter } from '../state/calendarActions.js';
const EVENT_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';
const ROOT = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
interface TokenResponse { access_token?: string; expires_in?: number; error?: string }
interface OAuthLibrary {
  initTokenClient(config: { client_id: string; scope: string; include_granted_scopes: boolean; callback: (r: TokenResponse) => void; error_callback: () => void }): { requestAccessToken(input: {prompt:string}): void };
  hasGrantedAllScopes(response:TokenResponse,...scopes:string[]): boolean;
}
function oauth(): OAuthLibrary | undefined { return (globalThis as typeof globalThis & { google?: { accounts?: { oauth2?: OAuthLibrary } } }).google?.accounts?.oauth2; }
/** Prepare only after the user chooses to connect. A second gesture opens the OAuth popup. */
export async function prepareCalendarAuthorization(allowed: boolean): Promise<void> {
  if (!allowed) throw new Error('ローカル限定モードでは接続できません。');
  if (oauth()) return;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
    const timeout = setTimeout(() => { script.remove(); reject(new Error('Google接続の準備がタイムアウトしました。')); }, 15000);
    script.onload = () => { clearTimeout(timeout); oauth() ? resolve() : reject(new Error('Google接続を準備できませんでした。')); };
    script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('Google接続を準備できませんでした。')); };
    document.head.appendChild(script);
  });
}
export interface CalendarCredential { token: string; expiresAt: number; account: CalendarAccount }
export function authorizeCalendar(clientId: string, allowed: boolean, signal?: AbortSignal): Promise<CalendarCredential> {
  if (!allowed || !clientId || !oauth() || signal?.aborted) return Promise.reject(new Error('Google接続の設定・準備を確認してください。'));
  return new Promise((resolve, reject) => {
    let settled = false, received = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', fail); };
    const fail = () => { if (settled) return; settled = true; cleanup(); reject(new Error('Google接続が取り消されたか、必要な権限が許可されませんでした。')); };
    const timer = setTimeout(fail, 120000);
    signal?.addEventListener('abort', fail, {once:true});
    try {
      const library = oauth()!;
      const client = library.initTokenClient({ client_id:clientId, scope:`openid email ${EVENT_SCOPE}`, include_granted_scopes:false, error_callback:fail,
        callback: r => {
          if (settled || received || signal?.aborted) return;
          received = true;
          if (!r.access_token || r.error || !library.hasGrantedAllScopes(r, EVENT_SCOPE, 'openid')) { fail(); return; }
          const token = r.access_token;
          void fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers:{ Authorization:`Bearer ${token}` }, signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
            .then(async response => {
              if (!response.ok) throw new Error('account unavailable');
              const user = await response.json();
              if (typeof user.sub !== 'string' || !user.sub || typeof user.email !== 'string' || !user.email) throw new Error('account unavailable');
              if (settled || signal?.aborted) return;
              settled = true; cleanup();
              resolve({token, expiresAt:Date.now()+Math.max(0,Math.min(Number(r.expires_in)||0,3600)-30)*1000, account:{subject:user.sub,email:user.email}});
            }).catch(fail);
        },
      });
      client.requestAccessToken({ prompt:'select_account' });
    } catch { fail(); }
  });
}
/** Only primary-calendar events, no attendees, sharing or email sending. */
export class GoogleCalendarAdapter implements CalendarAdapter {
  readonly account: CalendarAccount;
  constructor(private readonly credential: CalendarCredential, private readonly allowed: () => boolean, private readonly request: typeof fetch = fetch, private readonly signal?: AbortSignal) { this.account = credential.account; }
  private call(url: string, options: RequestInit = {}): Promise<Response> {
    if (!this.allowed() || this.signal?.aborted) throw new Error('cloud access disabled');
    if (this.credential.expiresAt <= Date.now()) throw new Error('authorization expired');
    return this.request(url, { ...options, headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${this.credential.token}` }, signal:this.signal ? AbortSignal.any([this.signal,AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  }
  async insert(action: CalendarAction): Promise<void> {
    const p = validateCalendarPayload(action.payload);
    const response = await this.call(ROOT, {method:'POST',body:JSON.stringify({id:action.id, summary:p.title, start:{dateTime:p.start,timeZone:p.timeZone},end:{dateTime:p.end,timeZone:p.timeZone},extendedProperties:{private:{rcaiAction:action.id}}})});
    if (!response.ok && response.status !== 409) throw new Error('calendar write unconfirmed');
  }
  async matches(action: CalendarAction): Promise<'verified'|'missing'|'mismatch'> {
    const response = await this.call(`${ROOT}/${encodeURIComponent(action.id)}`);
    if (response.status === 404) return 'missing';
    if (!response.ok) throw new Error('calendar read unavailable');
    const event = await response.json(), p = validateCalendarPayload(action.payload);
    return event.id === action.id && event.status !== 'cancelled' && event.summary === p.title &&
      Date.parse(event.start?.dateTime) === Date.parse(p.start) && Date.parse(event.end?.dateTime) === Date.parse(p.end) &&
      event.extendedProperties?.private?.rcaiAction === action.id && (!event.attendees || event.attendees.length === 0) ? 'verified' : 'mismatch';
  }
}
