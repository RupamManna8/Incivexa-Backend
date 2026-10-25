import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Explicitly load root .env regardless of working directory
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config();

// Mapping of Indian states/regions to standard state codes
const INDIA_STATE_CODE_MAP = {
    'Maharashtra': 'MH',
    'Karnataka': 'KA',
    'Delhi': 'DL',
    'Delhi NCR': 'DL',
    'National Capital Territory of Delhi': 'DL',
    'Tamil Nadu': 'TN',
    'Telangana': 'TG',
    'Gujarat': 'GJ',
    'Uttar Pradesh': 'UP',
    'West Bengal': 'WB',
    'Kerala': 'KL',
    'Rajasthan': 'RJ',
    'Haryana': 'HR',
    'Punjab': 'PB',
    'Madhya Pradesh': 'MP',
    'Andhra Pradesh': 'AP',
    'Bihar': 'BR',
    'Odisha': 'OD'
};

export class LocationService {
    constructor() {
        this.Cache = new Map();
        this.CacheSize = 250;
        this.CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
        this.PROVIDER_URL = (process.env.LOCATION_PROVIDER_URL || "https://api.ip2location.io").replace(/\/+$/, "");
        this.API_KEY = process.env.LOCATION_PROVIDER_KEY || "";

        // Running live in-memory aggregation of telemetry geo hits
        this.liveGeoHits = new Map();
    }

    /**
     * Clear in-memory live hits and caches
     */
    clearLiveHits() {
        this.liveGeoHits.clear();
        this.Cache.clear();
    }

    /**
     * Checks if an IP is within private RFC-1918, loopback, or internal ranges
     */
    isPrivateIp(ip) {
        if (!ip || ip === 'localhost' || ip === '::1' || ip === '127.0.0.1') return true;
        return /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|169\.254\.)/.test(ip);
    }

    /**
     * SetCache stores the resolved IP location in memory with LRU eviction
     */
    async SetCache(ip, data) {
        if (!ip || !data) return;
        this.Cache.set(ip, { data, timestamp: Date.now() });

        // If cache grows beyond allowed limit, evict the oldest entry
        if (this.Cache.size > this.CacheSize) {
            const oldestKey = this.Cache.keys().next().value;
            this.Cache.delete(oldestKey);
        }
    }

    /**
     * GetCache checks if we already have a recent entry for this IP
     */
    async GetCache(ip) {
        if (!ip) return null;
        const cachedItem = this.Cache.get(ip);
        if (!cachedItem) return null;

        // Check if the cached entry has expired
        const isExpired = Date.now() - cachedItem.timestamp > this.CACHE_EXPIRY_MS;
        if (isExpired) {
            this.Cache.delete(ip);
            return null;
        }

        return cachedItem.data;
    }

    /**
     * Resolves geographical coordinates and location details for an IP
     */
    FetchLocationWithIP = async (ip) => {
        if (!ip) return null;

        // Clean IPv6-mapped IPv4 addresses (e.g. ::ffff:192.168.1.1)
        const cleanIp = String(ip).replace(/^::ffff:/, '').trim();

        // 1. Check LRU Cache
        const cached = await this.GetCache(cleanIp);
        if (cached) {
            return cached;
        }

        // 2. Local / Private Cluster Fallback (Delhi NCR default for local dev)
        if (this.isPrivateIp(cleanIp)) {
            const localData = {
                ip: cleanIp,
                type: 'ipv4 (internal cluster)',
                country_code: 'IN',
                country_name: 'India',
                region_name: 'Delhi NCR',
                city_name: 'New Delhi',
                latitude: 28.6139,
                longitude: 77.2090,
                zip_code: '110001',
                time_zone: '+05:30',
                is_private: true
            };
            await this.SetCache(cleanIp, localData);
            return localData;
        }

        // 3. Query External Geolocation Provider (IP2Location / IPStack)
        try {
            const queryParams = new URLSearchParams({ ip: cleanIp });
            if (this.API_KEY) {
                queryParams.append("key", this.API_KEY);
            }

            const requestUrl = `${this.PROVIDER_URL}/?${queryParams.toString()}`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);

            const res = await fetch(requestUrl, { signal: controller.signal });
            clearTimeout(timeout);

            const data = await res.json();
            if (data && !data.error) {
                const countryCode = (data.country_code || data.country || 'IN').toUpperCase();
                const isIndia = countryCode === 'IN';
                let regionName = data.region_name || data.region || (isIndia ? 'Maharashtra' : 'Outside India');
                if (regionName === 'Delhi' || regionName.includes('National Capital Territory')) {
                    regionName = 'Delhi NCR';
                }

                const normalized = {
                    ip: data.ip || cleanIp,
                    country_code: countryCode,
                    country_name: data.country_name || (isIndia ? 'India' : 'International'),
                    region_name: regionName,
                    city_name: data.city_name || data.city || (isIndia ? 'Mumbai' : 'Global Edge'),
                    latitude: Number(data.latitude) || (isIndia ? 19.0760 : 0),
                    longitude: Number(data.longitude) || (isIndia ? 72.8777 : 0),
                    zip_code: data.zip_code || data.zip || '',
                    time_zone: data.time_zone || '+05:30',
                    as: data.as || 'Cloud Provider',
                    is_proxy: Boolean(data.is_proxy)
                };

                await this.SetCache(cleanIp, normalized);
                return normalized;
            }
            return data;
        } catch (error) {
            console.warn(`[LocationService] Geolocation provider notice for ${cleanIp}:`, error.message);
            const fallback = {
                ip: cleanIp,
                country_code: 'IN',
                country_name: 'India',
                region_name: 'Maharashtra',
                city_name: 'Mumbai',
                latitude: 19.0760,
                longitude: 72.8777,
                is_fallback: true
            };
            return fallback;
        }
    };

    /**
     * Tracks live request origin hits for dashboard analytics
     */
    recordGeoHit(geoData, latency = 25, isError = false) {
        if (!geoData) return;

        const isIndia = (geoData.country_code || 'IN').toUpperCase() === 'IN';
        let regionKey = isIndia
            ? (geoData.region_name || 'Maharashtra')
            : 'Outside India';

        if (regionKey === 'Delhi' || regionKey.includes('National Capital Territory')) {
            regionKey = 'Delhi NCR';
        }

        const stateCode = isIndia
            ? (INDIA_STATE_CODE_MAP[regionKey] || geoData.country_code || 'IN')
            : 'INTL';

        const current = this.liveGeoHits.get(regionKey) || {
            state: regionKey,
            code: stateCode,
            country: isIndia ? 'India' : 'Outside India',
            requests: 0,
            errors: 0,
            totalLatency: 0,
            cities: new Map()
        };

        current.requests += 1;
        if (isError) current.errors += 1;
        current.totalLatency += Number(latency) || 25;

        const cityName = geoData.city_name || (isIndia ? 'Mumbai' : 'Global Edge / Roaming');
        const city = current.cities.get(cityName) || {
            name: cityName,
            requests: 0,
            errors: 0,
            totalLatency: 0
        };
        city.requests += 1;
        if (isError) city.errors += 1;
        city.totalLatency += Number(latency) || 25;
        current.cities.set(cityName, city);

        this.liveGeoHits.set(regionKey, current);
    }

    /**
     * Generates aggregated geographical distribution for the dashboard analytics
     */
    async getGeoDistribution(env = 'production', projectId = null) {
        if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
            return {
                totalRequests: 0,
                domesticShare: 100,
                outsideIndiaShare: 0,
                regions: []
            };
        }

        const regionMap = new Map();

        // Ensure API key is up to date from environment
        if (!this.API_KEY && process.env.LOCATION_PROVIDER_KEY) {
            this.API_KEY = process.env.LOCATION_PROVIDER_KEY;
        }

        // 1. Query real TelemetryEvents from MongoDB if available
        if (mongoose.connection.readyState === 1) {
            try {
                const TelemetryEvent = mongoose.models.TelemetryEvent;
                if (TelemetryEvent) {
                    const match = {};
                    if (projectId && projectId !== 'all') {
                        if (mongoose.Types.ObjectId.isValid(projectId)) {
                            match.projectId = { $in: [new mongoose.Types.ObjectId(projectId), String(projectId)] };
                        } else {
                            match.projectId = String(projectId);
                        }
                    }
                    if (env && env !== 'all') {
                        match.env = { $regex: new RegExp(`^${env}$`, 'i') };
                    }

                    const events = await TelemetryEvent.find(match, { tags: 1, metrics: 1, severity: 1, location: 1 }).lean().limit(2000);
                    for (const ev of events) {
                        const ip = ev.tags?.client_ip || ev.tags?.ip || '127.0.0.1';
                        const isError = ev.severity === 'error' || ev.severity === 'critical' || parseInt(ev.tags?.http_status || 0) >= 400;
                        const duration = ev.metrics?.duration_ms || 25;

                        let loc = ev.location || (await this.GetCache(ip));
                        if (!loc) {
                            loc = await this.FetchLocationWithIP(ip);
                        }

                        if (loc) {
                            const isIndia = (loc.country_code || 'IN').toUpperCase() === 'IN';
                            let regionKey = isIndia ? (loc.region_name || 'Maharashtra') : 'Outside India';
                            if (regionKey === 'Delhi' || regionKey.includes('National Capital Territory')) {
                                regionKey = 'Delhi NCR';
                            }
                            const stateCode = isIndia ? (INDIA_STATE_CODE_MAP[regionKey] || loc.country_code || 'IN') : 'INTL';
                            const cityName = loc.city_name || (isIndia ? 'New Delhi' : 'Global Edge');

                            const existing = regionMap.get(regionKey) || {
                                state: regionKey,
                                code: stateCode,
                                country: isIndia ? 'India' : 'Outside India',
                                requests: 0,
                                totalLatency: 0,
                                errors: 0,
                                cities: new Map()
                            };

                            existing.requests += 1;
                            existing.totalLatency += duration;
                            if (isError) existing.errors += 1;

                            const cityObj = existing.cities.get(cityName) || {
                                name: cityName,
                                requests: 0,
                                totalLatency: 0,
                                errors: 0
                            };
                            cityObj.requests += 1;
                            cityObj.totalLatency += duration;
                            if (isError) cityObj.errors += 1;
                            existing.cities.set(cityName, cityObj);

                            regionMap.set(regionKey, existing);
                        }
                    }
                }
            } catch (err) {
                console.warn('[LocationService] Aggregation notice:', err.message);
            }
        }

        // 2. Merge live in-memory recorded hits if database had no events or was offline
        if (regionMap.size === 0 && this.liveGeoHits.size > 0) {
            for (const [stateKey, live] of this.liveGeoHits.entries()) {
                const existing = regionMap.get(stateKey) || {
                    state: live.state,
                    code: live.code,
                    country: live.country,
                    requests: 0,
                    totalLatency: 0,
                    errors: 0,
                    cities: new Map()
                };

                // Avoid double counting if events were already parsed
                if (regionMap.size === 0) {
                    existing.requests += live.requests;
                    existing.totalLatency += live.totalLatency;
                    existing.errors += live.errors;

                    for (const [cityName, liveCity] of live.cities.entries()) {
                        const exCity = existing.cities.get(cityName) || {
                            name: cityName,
                            requests: 0,
                            totalLatency: 0,
                            errors: 0
                        };
                        exCity.requests += liveCity.requests;
                        exCity.totalLatency += liveCity.totalLatency;
                        exCity.errors += liveCity.errors;
                        existing.cities.set(cityName, exCity);
                    }

                    regionMap.set(stateKey, existing);
                }
            }
        }

        // 3. Compute totals and percentages
        let totalRequests = 0;
        let totalDomestic = 0;
        let totalInternational = 0;

        for (const reg of regionMap.values()) {
            totalRequests += reg.requests;
            if (reg.country === 'India') {
                totalDomestic += reg.requests;
            } else {
                totalInternational += reg.requests;
            }
        }

        if (totalRequests === 0) {
            return {
                totalRequests: 0,
                regions: [],
                topRegion: null,
                domesticShare: 100,
                outsideIndiaShare: 0,
                cachedIpCount: this.Cache.size,
                liveHitCount: 0
            };
        }

        const regions = [];
        let outsideIndiaShare = 0;

        for (const reg of regionMap.values()) {
            const share = Number(((reg.requests / totalRequests) * 100).toFixed(1));
            const avgLatency = Math.round(reg.totalLatency / reg.requests);
            const errorRate = Number(((reg.errors / reg.requests) * 100).toFixed(2));

            const citiesList = Array.from(reg.cities.values()).map(c => ({
                name: c.name,
                requests: c.requests,
                latency: Math.round(c.totalLatency / (c.requests || 1)) || avgLatency,
                errorRate: Number(((c.errors / (c.requests || 1)) * 100).toFixed(2)) || errorRate
            }));

            // Sort cities by requests descending
            citiesList.sort((a, b) => b.requests - a.requests);

            const regionObj = {
                state: reg.state,
                code: reg.code,
                country: reg.country,
                share,
                requests: reg.requests,
                latency: avgLatency || 25,
                errorRate: errorRate || 0,
                cities: citiesList
            };

            if (reg.state === 'Outside India') {
                outsideIndiaShare = share;
            }

            regions.push(regionObj);
        }

        // Sort regions by traffic volume descending
        regions.sort((a, b) => {
            if (a.state === 'Outside India') return 1;
            if (b.state === 'Outside India') return -1;
            return b.requests - a.requests;
        });

        const domesticShare = totalRequests > 0 ? Number(((totalDomestic / totalRequests) * 100).toFixed(1)) : 100;

        return {
            totalRequests,
            regions,
            topRegion: regions[0] || null,
            domesticShare,
            outsideIndiaShare: Number((100 - domesticShare).toFixed(1)),
            cachedIpCount: this.Cache.size,
            liveHitCount: totalRequests
        };
    }
}

// Backwards-compatible alias for typo safety
export const LoationService = LocationService;
export const locationService = new LocationService();
export default locationService;
