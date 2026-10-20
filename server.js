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

app.get('/live/checkversion', async (_req, res) => {
    try {
        const { data, error } = await db()
            .from('server_settings')
            .select('correct_version,server_version,server_dev_version,is_online,closed_until')
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
        console.log('[Notice] Player data requires verified Steam authentication middleware.');
        app.listen(PORT, '0.0.0.0', () => console.log(`[Server] Backend running on port ${PORT}`));
    } catch (error) {
        console.error('[Supabase] Connection failed:', error.message);
        process.exit(1);
    }
}

startServer();
