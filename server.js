require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Safe request diagnostics: records paths and status only, never auth headers or bodies.
app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
        console.log(`[HTTP] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - startedAt}ms`);
    });
    next();
});

const PORT = Number(process.env.PORT) || 3000;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SECRET_KEY = (
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
).trim();
const STEAM_APP_ID = (process.env.STEAM_APP_ID || '2334220').trim();
const hasSteamApiKey = Boolean((process.env.STEAM_API_KEY || '').trim());
const DISCORD_AUTH_ME_URL = (process.env.DISCORD_AUTH_ME_URL || '').trim();
const WHITELIST_WEBHOOK_SECRET = (process.env.WHITELIST_WEBHOOK_SECRET || '').trim();

let supabase;

function db() {
    if (!supabase) throw new Error('Supabase client is not initialized');
    return supabase;
}

// ==========================================
// Player API
// ==========================================

app.get('/live/checkversion', async (_req, res) => {
    try {
        const { data, error } = await db()
            .from('server_settings')
            .select('correct_version,server_version,server_dev_version,is_online,is_dev_online,closed_until')
            .eq('id', 'main')
            .maybeSingle();
        if (error) throw error;

        return res.json({
            code: 0,
            message: 'Version valid',
            status: true,
            correctversion: data?.correct_version ?? true,
            serverVersion: data?.server_version ?? '1.0.6.0',
            ServerDevVersion: data?.server_dev_version ?? '0.0.0.1',
            IsOnline: data?.is_online ?? true,
            IsDevOnline: data?.is_dev_online ?? false,
            __v: 0,
            ClosedUntil: data?.closed_until ?? null,
            serverTime: Date.now()
        });
    } catch (error) {
        console.error('[checkversion] Supabase query failed:', error.message);
        return res.status(500).json({
            code: 500,
            message: 'Version check failed',
            status: false,
            serverTime: Date.now()
        });
    }
});

// Resolve the Discord identity from the short-lived OAuth token. Never trust
// a Discord ID supplied as a query parameter or request body.
async function verifyDiscordBearer(req) {
    const authorization = String(req.get('authorization') || '');
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        const error = new Error('Authentication required');
        error.statusCode = 401;
        throw error;
    }
    if (!DISCORD_AUTH_ME_URL) {
        const error = new Error('Discord token verification is not configured');
        error.statusCode = 503;
        throw error;
    }
    const authUrl = new URL(DISCORD_AUTH_ME_URL);
    if (authUrl.protocol !== 'https:') throw new Error('Auth verification URL must use HTTPS');
    const authResponse = await fetch(authUrl, {
        headers: { Authorization: `Bearer ${match[1]}` },
        signal: AbortSignal.timeout(10000)
    });
    if (!authResponse.ok) {
        const error = new Error('Authentication failed');
        error.statusCode = 401;
        throw error;
    }
    const identity = await authResponse.json();
    const discordId = String(identity?.discordId || '').trim();
    if (identity?.authenticated !== true || !/^[0-9]{17,20}$/.test(discordId)) {
        const error = new Error('Authentication failed');
        error.statusCode = 401;
        throw error;
    }
    return discordId;
}

// Server-to-server endpoint for the whitelist website. Call this only after
// the website has approved an application; never expose this secret in browser JS.
app.post('/api/whitelist/approve', async (req, res) => {
    try {
        if (!WHITELIST_WEBHOOK_SECRET) {
            return res.status(503).json({ error: 'Whitelist integration is not configured' });
        }
        const suppliedSecret = String(req.get('x-whitelist-secret') || '');
        const expected = Buffer.from(WHITELIST_WEBHOOK_SECRET);
        const supplied = Buffer.from(suppliedSecret);
        if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const steamId = String(req.body?.steamId || '').trim();
        const discordId = String(req.body?.discordId || '').trim();
        const displayName = String(req.body?.displayName || '').trim();
        const discordTag = String(req.body?.discordTag || '').trim();
        if (!/^[0-9]{17}$/.test(steamId)) return res.status(400).json({ error: 'steamId must be 17 digits' });
        if (!/^[0-9]{17,20}$/.test(discordId)) return res.status(400).json({ error: 'discordId is invalid' });
        if (displayName.length < 1 || displayName.length > 64) return res.status(400).json({ error: 'displayName must be 1–64 characters' });
        if (discordTag.length > 100) return res.status(400).json({ error: 'discordTag is too long' });

        // Prevent accidental reassignment when the same Discord account is
        // already linked to a different Steam account (or vice versa).
        const { data: discordOwner, error: discordLookupError } = await db().from('players')
            .select('steam_id').eq('discord_id', discordId).limit(1).maybeSingle();
        if (discordLookupError) throw discordLookupError;
        if (discordOwner && discordOwner.steam_id !== steamId) {
            return res.status(409).json({ error: 'Discord account is already linked to another Steam account' });
        }
        const { data: steamOwner, error: steamLookupError } = await db().from('players')
            .select('discord_id').eq('steam_id', steamId).maybeSingle();
        if (steamLookupError) throw steamLookupError;
        if (steamOwner?.discord_id && steamOwner.discord_id !== discordId) {
            return res.status(409).json({ error: 'Steam account is already linked to another Discord account' });
        }

        const now = new Date().toISOString();
        const { error } = await db().from('players').upsert({
            steam_id: steamId,
            display_name: displayName,
            discord_id: discordId,
            discord_tag: discordTag || null,
            whitelisted_at: now,
            is_whitelisted: true,
            updated_at: now
        }, { onConflict: 'steam_id' });
        if (error) throw error;
        return res.status(200).json({ ok: true, steamId, discordId, isWhitelisted: true });
    } catch (error) {
        console.error('[whitelist/approve] Failed:', error.message);
        return res.status(500).json({ error: 'Could not save approved whitelist entry' });
    }
});

app.get('/live/player/ban-status', async (req, res) => {
    try {
        const discordId = await verifyDiscordBearer(req);
        const { data: player, error } = await db().from('players')
            .select('steam_id,is_whitelisted,is_banned,banned_until,ban_reason')
            .eq('discord_id', discordId).limit(1).maybeSingle();
        if (error) throw error;
        if (!player) return res.json({ found: false, isWhitelisted: false, isBanned: false });

        let isBanned = player.is_banned;
        let bannedUntil = player.banned_until;
        let banReason = player.ban_reason;
        if (isBanned && bannedUntil && new Date(bannedUntil).getTime() <= Date.now()) {
            const { error: updateError } = await db().from('players').update({
                is_banned: false, banned_until: null, ban_reason: null, updated_at: new Date().toISOString()
            }).eq('steam_id', player.steam_id);
            if (updateError) throw updateError;
            isBanned = false;
            bannedUntil = null;
            banReason = null;
        }
        return res.json({
            found: true,
            isWhitelisted: player.is_whitelisted === true,
            isBanned,
            bannedUntil,
            banReason
        });
    } catch (error) {
        console.error('[player/ban-status] Check failed:', error.message);
        return res.status(error.statusCode || 503).json({ message: error.message || 'Could not verify player ban status' });
    }
});

app.get('/live/player/getdata', async (req, res) => {
    try {
        const discordId = await verifyDiscordBearer(req);
        const { data: player, error } = await db()
            .from('players')
            .select('steam_id,display_name,is_whitelisted,is_banned,banned_until,level,experience,gold,gem')
            .eq('discord_id', discordId)
            .limit(1)
            .maybeSingle();
        if (error) throw error;
        if (!player) return res.status(404).json({ code: 404, message: 'Player not found', status: false });
        if (player.is_whitelisted !== true)
            return res.status(403).json({ code: 403, message: 'Player is not whitelisted', status: false });
        if (player.is_banned && (!player.banned_until || new Date(player.banned_until).getTime() > Date.now()))
            return res.status(403).json({ code: 403, message: 'Player is banned', status: false });

        return res.json({
            code: 0,
            message: 'Success',
            data: {
                uid: player.steam_id,
                name: player.display_name,
                level: player.level,
                exp: player.experience,
                currency: {
                    gold: player.gold,
                    gem: player.gem
                }
            }
        });
    } catch (error) {
        console.error('[player/getdata] Supabase query failed:', error.message);
        return res.status(error.statusCode || 500).json({
            code: error.statusCode || 500,
            message: error.message || 'Unable to load player data',
            status: false
        });
    }
});

// ==========================================
// Steam information and health
// ==========================================

app.get('/live/steam/info', (_req, res) => {
    res.json({
        code: 0,
        message: 'Steam Config Success',
        appId: STEAM_APP_ID,
        hasApiKey: hasSteamApiKey
    });
});

app.get('/', (_req, res) => res.status(200).send('HSHO Player API is running.'));

app.get('/health', async (_req, res) => {
    try {
        const { error } = await db().from('server_settings').select('id').limit(1);
        if (error) throw error;
        return res.json({ status: 'ok', database: 'connected' });
    } catch (error) {
        console.error('[health] Supabase query failed:', error.message);
        return res.status(503).json({ status: 'database_disconnected', database: 'disconnected' });
    }
});

app.use('/live', (_req, res) => res.status(404).json({
    code: 404,
    message: 'API endpoint not found',
    status: false
}));

async function startServer() {
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
        console.error('[Startup Error] SUPABASE_URL and SUPABASE_SECRET_KEY are required.');
        process.exit(1);
    }
    if (!/^https:\/\//i.test(SUPABASE_URL)) {
        console.error('[Startup Error] SUPABASE_URL must use HTTPS.');
        process.exit(1);
    }

    supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
    });

    try {
        const { error } = await db().from('server_settings').select('id').limit(1);
        if (error) throw error;
        console.log('[Supabase] Connected.');
        console.log(`[Steam] App ID configured: ${STEAM_APP_ID}`);
        console.log(`[Steam] API key configured: ${hasSteamApiKey}`);
        console.log(`[Whitelist] Website integration configured: ${Boolean(WHITELIST_WEBHOOK_SECRET)}`);
        app.listen(PORT, '0.0.0.0', () => console.log(`[Server] Backend running on port ${PORT}`));
    } catch (error) {
        console.error('[Supabase] Connection failed:', error.message);
        process.exit(1);
    }
}

startServer();
