import type { Auth } from 'firebase/auth';
let auth: Auth | undefined;
let loading: Promise<Auth> | undefined;

/** Only the deployed broker origin may receive the app's Firebase ID token. */
export function hostedBrokerAllowed(brokerUrl: string): boolean {
  const configured = import.meta.env.VITE_RCAI_BROKER_URL;
  if (!configured) return false;
  try { return new URL(brokerUrl).href === new URL(configured).href; } catch { return false; }
}

export function hostedAuth(): Promise<Auth> {
  if (loading) return loading;
  loading = (async () => {
    const [{ initializeApp, getApps }, { getAuth, setPersistence, browserSessionPersistence }] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
    const response = await fetch('/__/firebase/init.json');
    if (!response.ok) throw new Error('ログインの設定を読み込めませんでした。');
    const config = await response.json();
    if (!config.apiKey || !config.projectId || !config.authDomain) throw new Error('ログインは現在準備中です。');
    const name = 'ai-meeting';
    auth = getAuth(getApps().find(a => a.name === name) ?? initializeApp(config, name));
    auth.languageCode = 'ja';
    await setPersistence(auth, browserSessionPersistence);
    await auth.authStateReady();
    return auth;
  })().catch(error => { loading = undefined; throw error; });
  return loading;
}

export interface TeamVoiceAccess { id: string; uid: string; consent: string }

export function hostedTokenFetch(brokerUrl: string, team?: TeamVoiceAccess): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const tokenEndpoint = `${brokerUrl.replace(/\/$/, '')}/api/token/gemini`;
    if (url !== tokenEndpoint || !hostedBrokerAllowed(brokerUrl) || !auth?.currentUser?.emailVerified) return fetch(input, init);
    if (team && (auth.currentUser.uid !== team.uid || !/^team-[a-f0-9]{24}$/.test(team.id))) throw new Error('チームのログイン状態が変わりました。');
    const token = await auth.currentUser.getIdToken();
    if (team && auth.currentUser?.uid !== team.uid) throw new Error('チームのログイン状態が変わりました。');
    const headers = new Headers(init?.headers); headers.set('Authorization', `Bearer ${token}`);
    if (team) {
      headers.set('Content-Type', 'application/json');
      return fetch(`${brokerUrl.replace(/\/$/, '')}/api/team/${team.id}`, { ...init, method: 'POST', headers, body: JSON.stringify({ action: 'voice', consent: team.consent }), redirect: 'error' });
    }
    return fetch(`${brokerUrl.replace(/\/$/, '')}/api/hosted/session`, { ...init, headers, redirect: 'error' });
  };
}
