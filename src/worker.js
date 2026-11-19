// Cloudflare Worker: serves public/ as static assets and proxies the Ravelry API.
// run_worker_first is on (see wrangler.jsonc) so the www redirect also covers pages.

const RAVELRY = 'https://api.ravelry.com';

function authHeaders(env) {
    return { Authorization: 'Basic ' + btoa(`${env.RAVELRY_USER}:${env.RAVELRY_PASSWORD}`) };
}

async function ravelry(env, path, params = {}) {
    const url = new URL(RAVELRY + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: authHeaders(env) });
    if (!res.ok) throw new Error(`Ravelry ${path} -> ${res.status}`);
    return res.json();
}

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
    });
}

// Fisher-Yates
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function designerOf(p) {
    return {
        designer: p.designer ? p.designer.name : 'Unknown',
        designerLink: p.designer ? p.designer.permalink : null,
    };
}

// 1. Autocomplete
async function patternSearch(env, url) {
    const q = url.searchParams.get('q');
    if (!q) return json([]);
    const data = await ravelry(env, '/patterns/search.json', { query: q, page_size: 10 });
    return json(data.patterns.map(p => ({ permalink: p.permalink, name: p.name, ...designerOf(p) })));
}

// Photo-project totals barely change. Kept per isolate, so it's a best-effort cache.
const TOTAL_TTL = 6 * 60 * 60 * 1000;
const totalCache = new Map();  // permalink -> { total, at }

async function getPhotoProjectTotal(env, permalink) {
    const hit = totalCache.get(permalink);
    if (hit && Date.now() - hit.at < TOTAL_TTL) return hit.total;
    const data = await ravelry(env, '/projects/search.json', { photo: 'yes', 'pattern-link': permalink, page_size: 1 });
    const total = data.paginator.results;
    totalCache.set(permalink, { total, at: Date.now() });
    return total;
}

// 2. Projects: a shuffled pool; the browser deals them out 8 at a time
const POOL_PAGES = 6;       // random pages sampled for big patterns
const POOL_PAGE_SIZE = 10;  // small pages = less clustering than 32 neighbours

async function patternProjects(env, url) {
    const patternLink = url.searchParams.get('pattern_link');
    if (!patternLink) return json({ error: 'pattern_link required' }, 400);

    const base = { photo: 'yes', 'pattern-link': patternLink };
    const total = await getPhotoProjectTotal(env, patternLink);
    let projects;

    if (total <= 100) {
        projects = (await ravelry(env, '/projects/search.json', { ...base, page_size: 100, page: 1 })).projects;
    } else {
        const maxPage = Math.ceil(total / POOL_PAGE_SIZE);
        const pages = new Set();
        while (pages.size < Math.min(POOL_PAGES, maxPage)) pages.add(Math.floor(Math.random() * maxPage) + 1);
        const results = await Promise.all([...pages].map(page =>
            ravelry(env, '/projects/search.json', { ...base, page_size: POOL_PAGE_SIZE, page })));
        projects = results.flatMap(r => r.projects);
    }

    const seen = new Set();
    const unique = projects
        .filter(p => {
            const img = p.first_photo?.medium_url;
            if (!img || seen.has(img)) return false;
            seen.add(img);
            return true;
        })
        .map(p => ({
            user: p.user?.username || 'Unknown',
            projectName: p.name,
            image: p.first_photo.medium_url,
            link: p.user ? `https://www.ravelry.com/projects/${p.user.username}/${p.permalink}` : '#',
        }));

    return json({ total, projects: shuffle(unique) }, 200, { 'Cache-Control': 'no-store' });
}

// 3. Popular patterns for the example buttons.
// Uses the bulk /patterns.json endpoint for project counts, so a rebuild is ~6
// subrequests (Workers free plan allows 50 per request).
const MIN_PROJECTS = 300;          // all projects, not just photo ones; ~100+ with photos
const MAX_LABEL_LENGTH = 24;
const POPULAR_TTL_SECONDS = 24 * 60 * 60;
const TRAILING_WORDS = /\s+(worsted|dk)$/i;   // so "Flax DK"/"Flax worsted" merge
const POPULAR_CACHE_KEY = 'https://cache.internal/popular-patterns-v1';

function makeLabel(name) {
    if (!/^[A-Za-z' -]+$/.test(name)) return null;   // skip digits/symbols
    if (/\bsocks?\b/i.test(name)) return null;
    const label = name.replace(TRAILING_WORDS, '').trim();
    if (label.length < 3 || label.length > MAX_LABEL_LENGTH) return null;
    return label;
}

async function buildPopularList(env) {
    const candidates = new Map();  // id -> pattern summary
    const searches = [];
    for (const sort of ['popularity', 'recently-popular']) {
        for (const page of [1, 2]) {
            searches.push(ravelry(env, '/patterns/search.json', { craft: 'knitting', pc: 'clothing', sort, page_size: 30, page }));
        }
    }
    for (const r of await Promise.all(searches)) {
        for (const p of r.patterns) {
            if (makeLabel(p.name)) candidates.set(p.id, { permalink: p.permalink, name: p.name, ...designerOf(p) });
        }
    }

    const ids = [...candidates.keys()];
    const counts = new Map();
    for (let i = 0; i < ids.length; i += 50) {
        const data = await ravelry(env, '/patterns.json', { ids: ids.slice(i, i + 50).join(' ') });
        for (const p of Object.values(data.patterns)) counts.set(p.id, p.projects_count || 0);
    }

    const byLabel = new Map();
    for (const [id, p] of candidates) {
        const count = counts.get(id) || 0;
        if (count < MIN_PROJECTS) continue;
        const label = makeLabel(p.name);
        const prev = byLabel.get(label.toLowerCase());
        if (!prev || count > prev.count) byLabel.set(label.toLowerCase(), { ...p, label, count });
    }
    return [...byLabel.values()].map(({ count, ...rest }) => rest);
}

let popularMemo = null;  // { list, at } per isolate, in front of the Cache API

async function popularPatterns(env, url, ctx) {
    if (popularMemo && Date.now() - popularMemo.at < POPULAR_TTL_SECONDS * 1000) return json(popularMemo.list);

    const cache = caches.default;
    const cached = await cache.match(POPULAR_CACHE_KEY);
    if (cached) {
        const list = await cached.json();
        popularMemo = { list, at: Date.now() };
        return json(list);
    }

    const list = await buildPopularList(env);
    if (list.length) {
        popularMemo = { list, at: Date.now() };
        ctx.waitUntil(cache.put(POPULAR_CACHE_KEY, json(list, 200, { 'Cache-Control': `max-age=${POPULAR_TTL_SECONDS}` })));
    }
    return json(list);
}

const ROUTES = {
    '/pattern-search': patternSearch,
    '/pattern-projects': patternProjects,
    '/popular-patterns': popularPatterns,
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // One canonical address
        if (url.hostname.startsWith('www.')) {
            url.hostname = url.hostname.slice(4);
            return Response.redirect(url.toString(), 301);
        }

        const handler = ROUTES[url.pathname];
        if (handler) {
            try {
                return await handler(env, url, ctx);
            } catch (err) {
                console.error(url.pathname, err.message);
                return json(url.pathname === '/pattern-search' || url.pathname === '/popular-patterns' ? [] : { error: 'Server Error' }, 500);
            }
        }

        return env.ASSETS.fetch(request);
    },
};
