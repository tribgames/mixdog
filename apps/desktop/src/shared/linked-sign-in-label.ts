/** A linked sign-in's provider as people know it: the identity provider's
 *  registrable domain mapped to its name, the domain itself otherwise. A
 *  display label only — detection treats every provider alike. */
const LABELS: Record<string, string> = {
  'google.com': 'Google',
  'apple.com': 'Apple',
  'microsoftonline.com': 'Microsoft',
  'microsoft.com': 'Microsoft',
  'live.com': 'Microsoft',
  'x.com': 'X',
  'twitter.com': 'X',
  'github.com': 'GitHub',
  'kakao.com': 'Kakao',
  'naver.com': 'Naver',
  'facebook.com': 'Facebook',
  'discord.com': 'Discord',
  'line.me': 'LINE',
};

export function linkedProviderLabel(provider: string): string {
  return LABELS[provider] ?? provider;
}
