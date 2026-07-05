/**
 * Queens Retreat backend — Cloudflare Worker.
 *
 * Serves the static site from ./public (handled by the assets config) and
 * exposes two JSON endpoints backed by a Google Sheet:
 *
 *   GET  /api/counts    → current registration totals + kids group occupancy
 *   POST /api/register  → validate + capacity-check + append a row to the sheet
 *
 * Required configuration:
 *   vars    : TOTAL_CAPACITY                            (wrangler.jsonc)
 *   secrets : SHEET_ID                — the Google Sheet ID (from its URL)
 *             GOOGLE_SA_EMAIL         — service account email
 *             GOOGLE_SA_PRIVATE_KEY   — service account private key (PEM, PKCS#8)
 *
 * The sheet's FIRST tab is used; the header row is created automatically on
 * the first registration if missing.
 */

const STATION_NAMES = {
    "1": "حضور الملكة (دنيا مخلوف)",
    "2": "اتزان الملكة (رويدة الشاويش)",
    "3": "صوت الملكة (نورا خطيب)",
    "4": "جذور الملكة (ديالا نبواني)",
    "5": "صورة الملكة (صابرين طافش)",
    "6": "شجاعة الملكة (انتصار قراعين وفداء الرازم)",
};

// Rotation rounds. The 4th slot is exclusive to صوت الملكة (station "3",
// المحطة الثابتة).
const TIME_SLOTS = ["10:30-11:15", "11:30-12:15", "12:30-13:15", "13:15-14:00"];
const EXTENDED_SLOT_STATIONS = new Set(["3"]);

// Sheet values for the childcare question: نعم = wants on-site kid care,
// لا = has external care arranged.
const KIDS_PLAN_LABELS = {
    external: "لا",
    onsite: "نعم",
};

const SHEET_HEADER = [
    "تاريخ التسجيل",
    "الاسم الكامل",
    "واتساب",
    "البريد الإلكتروني",
    "مكان السكن",
    "المسمى الوظيفي",
    "مكان العمل",
    "المحطات والمواعيد",
    "ترتيب رعاية الأطفال",
    "عدد الأطفال",
    "طريقة الدفع",
];

// bit is the only accepted payment method (transfer to the retreat's number).
const PAYMENT_METHOD_LABELS = {
    bit: "Bit",
};

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        try {
            if (url.pathname === "/api/counts" && request.method === "GET") {
                return await handleCounts(env);
            }
            if (url.pathname === "/api/register" && request.method === "POST") {
                return await handleRegister(request, env);
            }
        } catch (err) {
            console.error("API error:", err.stack || err.message || err);
            return json(500, {
                ok: false,
                error: "server_error",
                message: "حدث خطأ غير متوقع، يرجى المحاولة مرة أخرى.",
            });
        }

        return json(404, { ok: false, error: "not_found" });
    },
};

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

// Counts are cached in the isolate for a short window so page loads don't
// hammer the Sheets API. Invalidated after every successful registration.
let countsCache = { data: null, at: 0 };
const COUNTS_TTL_MS = 30_000;

async function handleCounts(env) {
    const counts = await getCounts(env, /* allowCache */ true);
    return json(200, { ok: true, ...counts });
}

async function handleRegister(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return json(400, {
            ok: false,
            error: "bad_request",
            message: "طلب غير صالح.",
        });
    }

    // Honeypot: bots that fill the invisible "website" field get a fake
    // success response and nothing is stored.
    if (typeof body.website === "string" && body.website.trim() !== "") {
        return json(200, { ok: true });
    }

    const clean = (v) => (typeof v === "string" ? v.trim() : "");
    const fullName = clean(body.fullName);
    const whatsapp = clean(body.whatsapp);
    const email = clean(body.email);
    const residence = clean(body.residence);
    const jobTitle = clean(body.jobTitle);
    const workplace = clean(body.workplace);

    if (!fullName || !whatsapp || !email || !residence || !jobTitle || !workplace) {
        return json(400, {
            ok: false,
            error: "missing_fields",
            message: "يرجى تعبئة جميع الحقول المطلوبة.",
        });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json(400, {
            ok: false,
            error: "invalid_email",
            message: "يرجى إدخال بريد إلكتروني صالح.",
        });
    }

    // Stations: exactly 3 unique stations, one valid time slot each, and no
    // two stations in the same rotation round.
    const stationsRaw = Array.isArray(body.stations) ? body.stations : [];
    const stations = [];
    const seenStations = new Set();
    const seenSlots = new Set();
    for (const entry of stationsRaw) {
        const id = String(entry && entry.id);
        const slot = String(entry && entry.slot);
        const allowedSlots = EXTENDED_SLOT_STATIONS.has(id)
            ? TIME_SLOTS
            : TIME_SLOTS.slice(0, 3);
        if (!STATION_NAMES[id] || seenStations.has(id) || !allowedSlots.includes(slot)) {
            continue;
        }
        if (seenSlots.has(slot)) {
            return json(400, {
                ok: false,
                error: "slot_clash",
                message: "لا يمكن اختيار الموعد نفسه لمحطتين مختلفتين.",
            });
        }
        seenStations.add(id);
        seenSlots.add(slot);
        stations.push({ id, slot });
    }
    if (stations.length !== 3 || stationsRaw.length !== 3) {
        return json(400, {
            ok: false,
            error: "invalid_stations",
            message: "يرجى اختيار 3 محطات بالضبط مع تحديد موعد صالح لكل محطة.",
        });
    }

    // Childcare question (only mothers answer it; optional otherwise).
    const kidsPlan = KIDS_PLAN_LABELS[body.kidsPlan] ? String(body.kidsPlan) : "";
    let kidsCount = "";
    if (kidsPlan === "onsite") {
        const n = parseInt(body.kidsCount, 10);
        if (!Number.isInteger(n) || n < 1 || n > 20) {
            return json(400, {
                ok: false,
                error: "missing_kids_count",
                message: "يرجى إدخال عدد الأطفال المراد دمجهم في الفعالية الموازية.",
            });
        }
        kidsCount = String(n);
    }

    // Capacity check against fresh (uncached) sheet data.
    const counts = await getCounts(env, /* allowCache */ false);

    if (counts.totalRegistered >= counts.totalCapacity) {
        return json(409, {
            ok: false,
            error: "sold_out",
            message: "نعتذر، اكتمل عدد المقاعد المتاحة للرتريت.",
        });
    }

    const timestamp = new Date().toLocaleString("en-GB", {
        timeZone: "Asia/Jerusalem",
        hour12: false,
    });
    const row = [
        timestamp,
        fullName,
        whatsapp,
        email,
        residence,
        jobTitle,
        workplace,
        stations.map((s) => `${STATION_NAMES[s.id]} @ ${s.slot}`).join(" | "),
        kidsPlan ? KIDS_PLAN_LABELS[kidsPlan] : "",
        kidsCount,
        PAYMENT_METHOD_LABELS[body.paymentMethod] || "",
    ];

    if (!counts.headerPresent) {
        await appendRow(env, SHEET_HEADER);
    }
    await appendRow(env, row);
    countsCache = { data: null, at: 0 };

    return json(200, { ok: true });
}

/* ------------------------------------------------------------------ */
/* Google Sheets access                                                */
/* ------------------------------------------------------------------ */

async function getCounts(env, allowCache) {
    if (allowCache && countsCache.data && Date.now() - countsCache.at < COUNTS_TTL_MS) {
        return countsCache.data;
    }

    const totalCapacity = parseInt(env.TOTAL_CAPACITY, 10) || 100;

    const token = await getAccessToken(env);
    const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values:batchGet` +
            `?ranges=${encodeURIComponent("A1:K1")}&ranges=${encodeURIComponent("A2:K")}`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
        throw new Error(`Sheets batchGet failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    const headerRows = data.valueRanges?.[0]?.values || [];
    const rows = data.valueRanges?.[1]?.values || [];

    const counts = {
        totalCapacity,
        totalRegistered: rows.length,
        seatsLeft: Math.max(0, totalCapacity - rows.length),
        headerPresent: headerRows.length > 0,
    };
    countsCache = { data: counts, at: Date.now() };
    return counts;
}

async function appendRow(env, row) {
    const token = await getAccessToken(env);
    const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(
            "A1:K1"
        )}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ values: [row] }),
        }
    );
    if (!res.ok) {
        throw new Error(`Sheets append failed: ${res.status} ${await res.text()}`);
    }
}

/* ------------------------------------------------------------------ */
/* Google service-account auth (JWT → OAuth token, no dependencies)    */
/* ------------------------------------------------------------------ */

let tokenCache = { token: null, exp: 0 };

async function getAccessToken(env) {
    if (!env.SHEET_ID || !env.GOOGLE_SA_EMAIL || !env.GOOGLE_SA_PRIVATE_KEY) {
        throw new Error(
            "Missing configuration: SHEET_ID, GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY secrets must be set."
        );
    }
    if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) {
        return tokenCache.token;
    }

    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
        JSON.stringify({
            iss: env.GOOGLE_SA_EMAIL,
            scope: "https://www.googleapis.com/auth/spreadsheets",
            aud: "https://oauth2.googleapis.com/token",
            iat: now,
            exp: now + 3600,
        })
    );
    const unsigned = `${header}.${claims}`;

    const key = await importPrivateKey(env.GOOGLE_SA_PRIVATE_KEY);
    const sig = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        new TextEncoder().encode(unsigned)
    );
    const jwt = `${unsigned}.${b64urlBytes(new Uint8Array(sig))}`;

    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:
            "grant_type=" +
            encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
            "&assertion=" +
            jwt,
    });
    if (!res.ok) {
        throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    tokenCache = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
    return tokenCache.token;
}

async function importPrivateKey(pem) {
    // Secrets pasted through dashboards sometimes carry literal "\n".
    const normalized = pem.replace(/\\n/g, "\n");
    const b64 = normalized
        .replace(/-----BEGIN PRIVATE KEY-----/, "")
        .replace(/-----END PRIVATE KEY-----/, "")
        .replace(/\s+/g, "");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey(
        "pkcs8",
        bytes.buffer,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
    );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function json(status, obj) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
        },
    });
}

function b64url(str) {
    return b64urlBytes(new TextEncoder().encode(str));
}

function b64urlBytes(bytes) {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
