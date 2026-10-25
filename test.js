import express from "express";
import ipaddr from "ipaddr.js";

const app = express();
const geoCache = new Map();

// Enable proxy trusting (useful behind reverse proxies, ngrok, load balancers)
app.set("trust proxy", true);

/**
 * Check if an IP address is a public routable address (unicast).
 */
function isPublicIP(ip) {
    if (!ip) return false;
    try {
        const addr = ipaddr.process(ip);
        return addr.range() === "unicast";
    } catch {
        return false;
    }
}

/**
 * Extract the true client IP from request headers or socket.
 */
function getClientIP(req) {
    // 1. Allow query override for quick manual testing (e.g. ?ip=8.8.8.8)
    if (req.query?.ip && typeof req.query.ip === "string") {
        return req.query.ip.trim();
    }

    // 2. Standard proxy / reverse proxy headers
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
        const first = (typeof forwarded === "string" ? forwarded : forwarded[0])
            .split(",")[0]
            .trim();
        if (first) return first.replace(/^::ffff:/, "");
    }

    const cfIp = req.headers["cf-connecting-ip"];
    if (cfIp) return String(cfIp).trim().replace(/^::ffff:/, "");

    const realIp = req.headers["x-real-ip"];
    if (realIp) return String(realIp).trim().replace(/^::ffff:/, "");

    // 3. Fallback to Express req.ip or socket remote address
    const rawIp = req.ip || req.socket?.remoteAddress || "";
    return rawIp.replace(/^::ffff:/, "").trim();
}

/**
 * Resolve geolocation details for an IP with multi-provider fallback and caching.
 */
async function getGeoLocation(ip) {
    if (!ip) return null;

    if (geoCache.has(ip)) {
        return geoCache.get(ip);
    }

    let location = null;

    // Provider 1: ipwho.is (fast, HTTPS, generous free tier)
    try {
        const targetUrl = isPublicIP(ip)
            ? `https://ipwho.is/${encodeURIComponent(ip)}`
            : "https://ipwho.is/"; // If local loopback/private, resolve machine's current public location

        const response = await fetch(targetUrl, {
            signal: AbortSignal.timeout(3500),
            headers: { "User-Agent": "Autonomous-Incident-Manager/1.0" }
        });

        if (response.ok) {
            const data = await response.json();
            if (data && data.success !== false) {
                location = {
                    ip: data.ip || ip,
                    city: data.city || "Unknown",
                    region: data.region || "Unknown",
                    country: data.country || "Unknown",
                    countryCode: data.country_code || "",
                    latitude: data.latitude,
                    longitude: data.longitude,
                    timezone: data.timezone?.id || data.timezone || "",
                    isp: data.connection?.isp || data.connection?.org || "",
                    isLocal: !isPublicIP(ip)
                };
            }
        }
    } catch (err) {
        // Fallback to next provider
    }

    // Provider 2: ip-api.com (reliable fallback)
    if (!location && isPublicIP(ip)) {
        try {
            const response = await fetch(
                `http://ip-api.com/json/${encodeURIComponent(ip)}`,
                { signal: AbortSignal.timeout(3500) }
            );
            if (response.ok) {
                const data = await response.json();
                if (data && data.status === "success") {
                    location = {
                        ip: data.query || ip,
                        city: data.city || "Unknown",
                        region: data.regionName || "Unknown",
                        country: data.country || "Unknown",
                        countryCode: data.countryCode || "",
                        latitude: data.lat,
                        longitude: data.lon,
                        timezone: data.timezone || "",
                        isp: data.isp || data.org || "",
                        isLocal: false
                    };
                }
            }
        } catch (err) {
            // Continue to fallback
        }
    }

    // Default fallback if all remote queries fail or offline
    if (!location) {
        location = {
            ip,
            city: isPublicIP(ip) ? "Unknown" : "Localhost",
            region: isPublicIP(ip) ? "Unknown" : "Local Network",
            country: isPublicIP(ip) ? "Unknown" : "Internal",
            countryCode: "",
            latitude: null,
            longitude: null,
            isLocal: !isPublicIP(ip)
        };
    }

    geoCache.set(ip, location);
    return location;
}

// Middleware: Identify user location on each request
app.use(async (req, res, next) => {
    try {
        const clientIp = getClientIP(req);
        req.clientIp = clientIp;
        req.location = await getGeoLocation(clientIp);

        console.log({
            time: new Date().toISOString(),
            method: req.method,
            path: req.path,
            clientIp: req.clientIp,
            location: req.location
        });
    } catch (error) {
        console.error("Error detecting location:", error.message);
        req.location = null;
    }

    next();
});

// Routes
app.get("/", (req, res) => {
    res.json({
        message: "Server running",
        clientIp: req.clientIp,
        location: req.location
    });
});

app.get("/location", (req, res) => {
    res.json({
        clientIp: req.clientIp,
        location: req.location
    });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        console.error(`Port ${PORT} is already in use. Set PORT=... or stop the running process.`);
    } else {
        console.error("Server error:", err);
    }
});