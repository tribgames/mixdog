export function decodeJwtPayload(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return null;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        return payload && typeof payload === 'object' ? payload : null;
    } catch {
        return null;
    }
}

export function expiryFromAccessToken(token) {
    const exp = Number(decodeJwtPayload(token)?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}

export function scrubOAuthSecrets(text, secretValues = []) {
    let scrubbed = String(text || '')
        .replace(/Bearer [A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
        .replace(/sk-ant-[A-Za-z0-9._-]+/g, '[REDACTED]')
        .replace(/"(accessToken|refreshToken|access_token|refresh_token|code|key)"\s*:\s*"[^"]+"/g,
            (_match, key) => `"${key}":"[REDACTED]"`);
    for (const secret of secretValues) {
        if (typeof secret === 'string' && secret) {
            scrubbed = scrubbed.split(secret).join('[REDACTED]');
        }
    }
    return scrubbed;
}
