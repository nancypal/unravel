require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.set('etag', false);  // disable ETag generation
app.use(cors());

const path = require('path');
// Serve index.html at root FIRST
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Then static files
app.use(express.static(path.join(__dirname)));

// HELPER: Auth Headers
const getAuthHeaders = () => {
    const authString = Buffer.from(`${process.env.RAVELRY_USER}:${process.env.RAVELRY_PASSWORD}`).toString('base64');
    return { 'Authorization': `Basic ${authString}` };
};

// HELPER: Fisher-Yates Shuffle
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// 1. Autocomplete Search Endpoint (Fixed to search Patterns, not Projects)
app.get('/pattern-search', async (req, res) => {
  try {
    if (!req.query.q) return res.json([]);
    
    const searchUrl = 'https://api.ravelry.com/patterns/search.json';
    
    const response = await axios.get(searchUrl, { 
        params: { query: req.query.q, page_size: 10 }, 
        headers: getAuthHeaders()
    });

    const suggestions = response.data.patterns.map(p => ({
      permalink: p.permalink,
      name: p.name,
      designer: p.designer ? p.designer.name : 'Unknown'
    }));

    res.json(suggestions);
  } catch (err) {
    console.error("Autocomplete Error:", err.message);
    res.status(500).json([]);
  }
});

// HELPER: total photo-projects for a pattern, cached (counts barely change)
const TOTAL_TTL = 6 * 60 * 60 * 1000;
const totalCache = new Map();  // permalink -> { total, at }

async function getPhotoProjectTotal(permalink) {
    const hit = totalCache.get(permalink);
    if (hit && Date.now() - hit.at < TOTAL_TTL) return hit.total;

    const res = await axios.get('https://api.ravelry.com/projects/search.json', {
        params: { photo: 'yes', 'pattern-link': permalink, page_size: 1 },
        headers: getAuthHeaders()
    });
    const total = res.data.paginator.results;
    totalCache.set(permalink, { total, at: Date.now() });
    return total;
}

// 2. Project Search Endpoint
// Returns a shuffled pool of projects; the browser deals them out 8 at a time.
const POOL_PAGES = 6;       // random pages sampled for big patterns
const POOL_PAGE_SIZE = 10;  // small pages = less clustering than 32 neighbours

app.get('/pattern-projects', async (req, res) => {
  try {
    const searchUrl = 'https://api.ravelry.com/projects/search.json';
    const { pattern_link } = req.query;
    if (!pattern_link) return res.status(400).json({ error: "pattern_link required" });

    const baseParams = { photo: 'yes', 'pattern-link': pattern_link };
    const totalResults = await getPhotoProjectTotal(pattern_link);

    let projects = [];

    if (totalResults <= 100) {
      // Small pattern: fetch everything
      const response = await axios.get(searchUrl, {
        params: { ...baseParams, page_size: 100, page: 1 },
        headers: getAuthHeaders()
      });
      projects = response.data.projects;

    } else {
      // Large pattern: sample several small random pages across the full range
      const maxPage = Math.ceil(totalResults / POOL_PAGE_SIZE);
      const pages = new Set();
      while (pages.size < Math.min(POOL_PAGES, maxPage)) {
        pages.add(Math.floor(Math.random() * maxPage) + 1);
      }

      const responses = await Promise.all(
        [...pages].map(page =>
          axios.get(searchUrl, {
            params: { ...baseParams, page_size: POOL_PAGE_SIZE, page },
            headers: getAuthHeaders()
          })
        )
      );
      projects = responses.flatMap(r => r.data.projects);
    }

    // Dedup, map, shuffle
    const seen = new Set();
    const unique = projects
      .filter(p => {
        if (!p.first_photo?.medium_url) return false;
        if (seen.has(p.first_photo.medium_url)) return false;
        seen.add(p.first_photo.medium_url);
        return true;
      })
      .map(p => ({
        user: p.user?.username || 'Unknown',
        projectName: p.name,
        image: p.first_photo.medium_url,
        link: p.user ? `https://www.ravelry.com/projects/${p.user.username}/${p.permalink}` : '#'
      }));

    res.set('Cache-Control', 'no-store');
    res.json({ total: totalResults, projects: shuffle(unique) });

  } catch (err) {
    console.error("Project Search Error:", err.message);
    res.status(500).json({ error: "Server Error" });
  }
});

// 3. Popular Patterns (for the example buttons)
const MIN_PHOTO_PROJECTS = 100;   // enough for several different refreshes
const MAX_LABEL_LENGTH = 24;
const POPULAR_TTL = 24 * 60 * 60 * 1000;
const TRAILING_WORDS = /\s+(worsted|dk)$/i;   // yarn-weight variants only, so "Flax DK"/"Flax worsted" merge

let popularCache = { list: [], at: 0 };
let popularBuilding = null;

function makeLabel(name) {
    if (!/^[A-Za-z' -]+$/.test(name)) return null;   // skip digits/symbols
    if (/\bsocks?\b/i.test(name)) return null;
    const label = name.replace(TRAILING_WORDS, '').trim();
    if (label.length < 3 || label.length > MAX_LABEL_LENGTH) return null;
    return label;
}

async function buildPopularList() {
    const byLabel = new Map();
    const candidates = new Map();

    for (const sort of ['popularity', 'recently-popular']) {
        for (const page of [1, 2]) {
            const r = await axios.get('https://api.ravelry.com/patterns/search.json', {
                params: { craft: 'knitting', pc: 'clothing', sort, page_size: 30, page },
                headers: getAuthHeaders()
            });
            r.data.patterns.forEach(p => candidates.set(p.permalink, { name: p.name, designer: p.designer ? p.designer.name : 'Unknown' }));
        }
    }

    const entries = [...candidates].filter(([, p]) => makeLabel(p.name));
    for (let i = 0; i < entries.length; i += 5) {   // small batches, be gentle on the API
        await Promise.all(entries.slice(i, i + 5).map(async ([permalink, { name, designer }]) => {
            const total = await getPhotoProjectTotal(permalink);
            if (total < MIN_PHOTO_PROJECTS) return;
            const label = makeLabel(name);
            const prev = byLabel.get(label.toLowerCase());
            if (!prev || total > prev.total) {   // "Flax DK"/"Flax worsted" -> keep the biggest
                byLabel.set(label.toLowerCase(), { permalink, name, designer, label, total });
            }
        }));
    }

    return [...byLabel.values()].map(({ permalink, name, designer, label }) => ({ permalink, name, designer, label }));
}

function refreshPopular() {
    if (popularBuilding) return popularBuilding;
    popularBuilding = buildPopularList()
        .then(list => { if (list.length) popularCache = { list, at: Date.now() }; })
        .catch(err => console.error("Popular Patterns Error:", err.message))
        .finally(() => { popularBuilding = null; });
    return popularBuilding;
}

// Never blocks: serves the cached list (empty until the first build finishes)
app.get('/popular-patterns', (req, res) => {
    if (Date.now() - popularCache.at > POPULAR_TTL) refreshPopular();
    res.json(popularCache.list);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  refreshPopular();  // warm the example-button list
});