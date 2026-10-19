require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const PORT = Number(process.env.PORT) || 3000;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SECRET_KEY = (
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
).trim();
const STEAM_APP_ID = (process.env.STEAM_APP_ID || '2334220').trim();
const hasSteamApiKey = Boolean((process.env.STEAM_API_KEY || '').trim());
const DISCORD_AUTH_ME_URL = (process.env.DISCORD_AUTH_ME_URL || '').trim();

let supabase;

function db() {
    if (!supabase) throw new Error('Supabase client is not initialized');
    return supabase;
}

// ==========================================
// Player API
// ==========================================

// Fail closed until a real, game-supported Steam ticket verifier is connected.
// The original source referenced req.user but did not contain authentication
// middleware that sets it. Do not trust a Steam ID supplied by an arbitrary client.
function requireVerifiedSteamUser(req, res, next) {
    const steamId = req.user?.steamId;
    if (typeof steamId !== 'string' || !/^\d{17}$/.test(steamId)) {
        return res.status(401).json({
            code: 401,
            message: 'Steam authentication required',
            status: false
        });
    }
    next();
}

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
            IsDevOnline: data?.is_dev_online ?? true,
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

// Validate the short-lived Discord OAuth token with the existing auth service;
// never accept a Discord ID supplied directly by the Launcher.
app.get('/live/player/ban-status', async (req, res) => {
    const authorization = String(req.get('authorization') || '');
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ message: 'Authentication required' });
    if (!DISCORD_AUTH_ME_URL) {
        return res.status(503).json({ message: 'Ban status authentication is not configured' });
    }
    try {
        const authUrl = new URL(DISCORD_AUTH_ME_URL);
        if (authUrl.protocol !== 'https:') throw new Error('Auth verification URL must use HTTPS');
        const authResponse = await fetch(authUrl, {
            headers: { Authorization: `Bearer ${match[1]}` },
            signal: AbortSignal.timeout(10000)
        });
        if (!authResponse.ok) return res.status(401).json({ message: 'Authentication failed' });
        const identity = await authResponse.json();
        const discordId = String(identity?.discordId || '').trim();
        if (identity?.authenticated !== true || !/^[0-9]{17,20}$/.test(discordId)) {
            return res.status(401).json({ message: 'Authentication failed' });
        }

        const { data: player, error } = await db().from('players')
            .select('steam_id,is_banned,banned_until,ban_reason')
            .eq('discord_id', discordId).eq('is_whitelisted', true).limit(1).maybeSingle();
        if (error) throw error;
        if (!player) return res.json({ found: false, isBanned: false });

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
        return res.json({ found: true, isBanned, bannedUntil, banReason });
    } catch (error) {
        console.error('[player/ban-status] Check failed:', error.message);
        return res.status(503).json({ message: 'Could not verify player ban status' });
    }
});

app.get('/live/player/getdata', requireVerifiedSteamUser, async (req, res) => {
    const steamId = req.user.steamId;
    try {
        let { data: player, error } = await db()
            .from('players')
            .select('steam_id,display_name,level,experience,currency_gold,currency_gem')
            .eq('steam_id', steamId)
            .maybeSingle();
        if (error) throw error;

        if (!player) {
            const created = await db().from('players').insert({ steam_id: steamId })
                .select('steam_id,display_name,level,experience,currency_gold,currency_gem')
                .single();
            if (created.error?.code === '23505') {
                const retry = await db().from('players')
                    .select('steam_id,display_name,level,experience,currency_gold,currency_gem')
                    .eq('steam_id', steamId).single();
                if (retry.error) throw retry.error;
                player = retry.data;
            } else {
                if (created.error) throw created.error;
                player = created.data;
            }
        }

        return res.json({
            code: 0,
            message: 'Success',
            data: {
                uid: player.steam_id,
                name: player.display_name,
                level: player.level,
                exp: player.experience,
                currency: {
                    gold: player.currency_gold,
                    gem: player.currency_gem
                }
            }
        });
    } catch (error) {
        console.error('[player/getdata] Supabase query failed:', error.message);
        return res.status(500).json({
            code: 500,
            message: 'Unable to load player data',
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
        console.log('[Notice] Player data requires verified Steam authentication middleware.');
        app.listen(PORT, '0.0.0.0', () => console.log(`[Server] Backend running on port ${PORT}`));
    } catch (error) {
        console.error('[Supabase] Connection failed:', error.message);
        process.exit(1);
    }
}

startServer();
