/*
 * apex_auth.h — header-only KeyAuth style client for the APEX AUTH panel
 *
 *   - dependency free (WinHTTP, ships with Windows)
 *   - C++17
 *   - drop it into your loader project and #include "apex_auth.h"
 *
 *   link with:  winhttp.lib   (the #pragma below does this for MSVC)
 *
 * API surface
 *   apex::Client c("https://your-panel.com", "apex");
 *   auto st  = c.Status();                         // online / offline / maintenance
 *   bool ok  = c.Login("user", "pass", hwid());     // fills c.token
 *   bool ok  = c.Activate("APEX-XXXX-XXXX-XXXX");  // binds the key to hwid
 *
 * ---------------------------------------------------------------------------
 *  Copyright (c) you. MIT licensed.
 * ---------------------------------------------------------------------------
 */
#pragma once

#if !defined(_WIN32)
#error "apex_auth.h requires Windows (WinHTTP)"
#endif

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winhttp.h>
#include <winreg.h>

#include <string>
#include <vector>

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "advapi32.lib")   /* MachineGuid lookup */

/* loader version reported to the panel — override before including:
     #define VERSION_STRING "2.1.0"
     #include "apex_auth.h"                                              */
#ifndef VERSION_STRING
#define VERSION_STRING "1.0.0"
#endif

namespace apex {

/* ------------------------------------------------------------------ */
/* tiny JSON helpers (flat objects are all this API returns)           */
/* ------------------------------------------------------------------ */
inline std::string jsonEscape(const std::string& s) {
    std::string o;
    o.reserve(s.size() + 8);
    for (char ch : s) {
        switch (ch) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n";  break;
            case '\r': o += "\\r";  break;
            case '\t': o += "\\t";  break;
            default:   o += ch;
        }
    }
    return o;
}

/** read `"key": "value"` (string value) out of a flat JSON object */
inline std::string jsonStr(const std::string& j, const std::string& key) {
    const std::string pat = "\"" + key + "\"";
    size_t p = j.find(pat);
    if (p == std::string::npos) return "";
    p = j.find(':', p + pat.size());
    if (p == std::string::npos) return "";
    p = j.find_first_not_of(" \t\r\n", p + 1);
    if (p == std::string::npos || j[p] != '"') return "";
    ++p;
    std::string out;
    while (p < j.size() && j[p] != '"') {
        if (j[p] == '\\' && p + 1 < j.size()) {
            ++p;
            switch (j[p]) {
                case 'n': out += '\n'; break;
                case 't': out += '\t'; break;
                case 'r': out += '\r'; break;
                default:  out += j[p];
            }
        } else out += j[p];
        ++p;
    }
    return out;
}

/** read `"key": 123` / `"key": true` */
inline long long jsonNum(const std::string& j, const std::string& key, long long fallback = 0) {
    const std::string pat = "\"" + key + "\"";
    size_t p = j.find(pat);
    if (p == std::string::npos) return fallback;
    p = j.find(':', p + pat.size());
    if (p == std::string::npos) return fallback;
    p = j.find_first_not_of(" \t\r\n", p + 1);
    if (p == std::string::npos) return fallback;
    try { return std::stoll(j.substr(p)); } catch (...) { return fallback; }
}
inline bool jsonBool(const std::string& j, const std::string& key, bool fallback = false) {
    const std::string pat = "\"" + key + "\"";
    size_t p = j.find(pat);
    if (p == std::string::npos) return fallback;
    p = j.find(':', p + pat.size());
    if (p == std::string::npos) return fallback;
    p = j.find_first_not_of(" \t\r\n", p + 1);
    if (p == std::string::npos) return fallback;
    return j.compare(p, 4, "true") == 0;
}

/* ------------------------------------------------------------------ */
/* machine fingerprint (HWID)                                          */
/* ------------------------------------------------------------------ */
inline std::string hwid() {
    HKEY key;
    if (RegOpenKeyExA(HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Cryptography",
                      0, KEY_READ | KEY_WOW64_64KEY, &key) != ERROR_SUCCESS)
        return "NO-HWID";
    char buf[256] = {0};
    DWORD len = sizeof(buf) - 1, type = REG_SZ;
    LONG r = RegQueryValueExA(key, "MachineGuid", nullptr, &type, (LPBYTE)buf, &len);
    RegCloseKey(key);
    if (r != ERROR_SUCCESS) return "NO-HWID";
    std::string s(buf);
    for (auto& c : s) c = (char)toupper((unsigned char)c);
    return s;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */
struct Response {
    DWORD status = 0;
    std::string body;
    bool ok() const { return status >= 200 && status < 300; }
};

class Client {
public:
    std::string base;   // https://panel.example.com
    std::string app;    // loader slug, e.g. "apex"
    std::string secret; // app/product secret (panel → Credentials); empty = bhejo hi mat
    std::string product;// product name/id, e.g. "Internal" — har call me bhejta hai
    std::string token;  // session token after Login()
    std::string client_version;  // khali ho to VERSION_STRING use hota hai
    int timeoutMs = 8000;

    /* last call ka result (compat layer ise use karta hai) */
    int         last_status  = 0;     // HTTP status (0 = server unreachable)
    std::string last_body;            // raw response JSON
    std::string loader_name;          // app.display name (Status ke baad)
    std::string download_url;         // panel ka download_url
    std::string changelog;            // panel ka changelog
    std::string product_name;         // init me bheja gaya product (panel se confirm)
    std::string license_json;         // last Activate() response

    Client() = default;
    Client(std::string baseUrl, std::string appSlug,
           std::string appSecret = "", std::string productName = "")
        : base(std::move(baseUrl)), app(std::move(appSlug)),
          secret(std::move(appSecret)), product(std::move(productName)) {
        while (!base.empty() && base.back() == '/') base.pop_back();
    }
    void setSecret(const std::string& s) { secret = s; }
    void setProduct(const std::string& p) { product = p; }

    /** "app" ke saath product bhi bhejo (agar set hai) */
    std::string productField() const {
        return product.empty() ? "" : ",\"product\":\"" + jsonEscape(product) + "\"";
    }

    /* ---------------- helpers ---------------- */
    static bool splitUrl(const std::string& url, bool& https, std::string& host,
                         std::string& extra, INTERNET_PORT& port) {
        size_t sch = url.find("://");
        if (sch == std::string::npos) return false;
        std::string scheme = url.substr(0, sch);
        https = (scheme == "https");
        size_t start = sch + 3;
        size_t slash = url.find('/', start);
        std::string authority = (slash == std::string::npos) ? url.substr(start)
                                                             : url.substr(start, slash - start);
        extra = (slash == std::string::npos) ? "" : url.substr(slash);
        size_t colon = authority.find(':');
        if (colon != std::string::npos) {
            port = (INTERNET_PORT)atoi(authority.substr(colon + 1).c_str());
            host = authority.substr(0, colon);
        } else {
            port = https ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT;
            host = authority;
        }
        return !host.empty();
    }

    /** POST a JSON body to <base><path>. token may be empty. */
    bool post(const std::string& path, const std::string& json,
              const std::string& bearer, Response& out, std::string& err) {
        last_status = 0;
        last_body.clear();
        bool https = false; std::string host, extra; INTERNET_PORT port = 0;
        if (!splitUrl(base, https, host, extra, port)) { err = "bad base url"; return false; }

        std::wstring whost(host.begin(), host.end());
        HINTERNET ses = WinHttpOpen(L"ApexLoader/1.0",
                                    WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                                    WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        if (!ses) { err = "WinHttpOpen failed"; return false; }
        WinHttpSetTimeouts(ses, timeoutMs, timeoutMs, timeoutMs, timeoutMs);

        HINTERNET con = WinHttpConnect(ses, whost.c_str(), port, 0);
        if (!con) { WinHttpCloseHandle(ses); err = "connect failed"; return false; }

        std::wstring wpath;
        {
            std::string full = extra + path;
            wpath.assign(full.begin(), full.end());
        }
        DWORD flags = https ? WINHTTP_FLAG_SECURE : 0;
        HINTERNET req = WinHttpOpenRequest(con, L"POST", wpath.c_str(), nullptr,
                                           WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
        if (!req) { WinHttpCloseHandle(con); WinHttpCloseHandle(ses); err = "open request failed"; return false; }

        std::wstring headers = L"Content-Type: application/json\r\n";
        if (!bearer.empty()) {
            std::wstring w = L"Authorization: Bearer ";
            w.append(bearer.begin(), bearer.end());
            w += L"\r\n";
            headers += w;
        }
        if (!secret.empty()) {                       // panel me "Require API secret" on ho to
            std::wstring w = L"x-api-key: ";
            w.append(secret.begin(), secret.end());
            w += L"\r\n";
            headers += w;
        }

        BOOL sent = WinHttpSendRequest(req, headers.c_str(), (DWORD)-1L,
                                       (LPVOID)json.data(), (DWORD)json.size(),
                                       (DWORD)json.size(), 0);
        if (!sent || !WinHttpReceiveResponse(req, nullptr)) {
            err = "request failed (server unreachable?)";
            WinHttpCloseHandle(req); WinHttpCloseHandle(con); WinHttpCloseHandle(ses);
            return false;
        }

        DWORD status = 0, sz = sizeof(status);
        WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &status, &sz, WINHTTP_NO_HEADER_INDEX);
        out.status = status;
        last_status = (int)status;

        char buf[4096]; DWORD read = 0;
        out.body.clear();
        while (WinHttpReadData(req, buf, sizeof(buf), &read) && read > 0) {
            out.body.append(buf, read);
            read = 0;
        }
        last_body = out.body;

        WinHttpCloseHandle(req); WinHttpCloseHandle(con); WinHttpCloseHandle(ses);
        err.clear();
        return true;
    }

    /* ---------------- API ---------------- */

    /** boot check: returns true when the loader may continue.
     *  On maintenance/offline, `message` carries the panel message. */
    bool Status(std::string& state, std::string& message, std::string& version) {
        Response r; std::string e;
        std::string ver = client_version.empty() ? std::string(VERSION_STRING) : client_version;
        std::string body = "{\"app\":\"" + jsonEscape(app) + "\",\"version\":\"" +
                           jsonEscape(ver) + "\"" + productField() + "}";
        if (!post("/api/loader/init", body, "", r, e)) { message = e; state = "offline"; return false; }
        state   = jsonStr(r.body, "status");
        message = jsonStr(r.body, "message");
        if (message.empty()) message = jsonStr(r.body, "error");
        version = jsonStr(r.body, "version");

        /* extra panel info (loader name / download / changelog / product echo) */
        loader_name  = jsonStr(r.body, "name");          // app.name (flat search)
        download_url = jsonStr(r.body, "download_url");
        changelog    = jsonStr(r.body, "changelog");

        product_name.clear();
        size_t pp = r.body.find("\"product\":{");         // nested product object
        if (pp != std::string::npos) {
            std::string sub = r.body.substr(pp);
            size_t end = sub.find('}');
            if (end != std::string::npos) sub = sub.substr(0, end);
            product_name = jsonStr(sub, "name");
        }
        return r.ok() && state != "offline" && state != "maintenance";
    }

    /** username / password login, stores the session token */
    bool Login(const std::string& user, const std::string& pass,
               const std::string& machineHwid, std::string& error) {
        Response r; std::string e;
        std::string body =
            "{\"app\":\"" + jsonEscape(app) + "\",\"username\":\"" + jsonEscape(user) +
            "\",\"password\":\"" + jsonEscape(pass) + "\",\"hwid\":\"" + jsonEscape(machineHwid) +
            "\"" + productField() + "}";
        if (!post("/api/loader/login", body, "", r, e)) { error = e; return false; }
        if (!r.ok()) { error = jsonStr(r.body, "error"); if (error.empty()) error = "login failed"; return false; }
        token = jsonStr(r.body, "token");
        error.clear();
        return !token.empty();
    }

    /** redeem a license key and bind it to the HWID.
     *  Token zaroori NAHI — panel key-only (guest) flow bhi chalta hai:
     *  bina login ke sirf unclaimed key chalti hai aur machine bind hoti hai. */
    bool Activate(const std::string& key, const std::string& machineHwid, std::string& error) {
        Response r; std::string e;
        std::string body = "{\"app\":\"" + jsonEscape(app) + "\",\"key\":\"" + jsonEscape(key) +
                           "\",\"hwid\":\"" + jsonEscape(machineHwid) + "\"" + productField() + "}";
        if (!post("/api/loader/activate", body, token, r, e)) { error = e; return false; }
        if (!r.ok()) { error = jsonStr(r.body, "error"); if (error.empty()) error = "activation failed"; return false; }
        license_json = r.body;
        error.clear();
        return true;
    }

    /** machine reset — login session ho to us account ki sab keys,
     *  warna (key-only loader) di hui key ka HWID hata do. */
    bool ResetHwid(const std::string& key, std::string& error) {
        std::string body = "{\"app\":\"" + jsonEscape(app) + "\"";
        if (!key.empty()) body += ",\"key\":\"" + jsonEscape(key) + "\"";
        body += productField() + "}";
        Response r; std::string e;
        if (!post("/api/loader/reset-hwid", body, token, r, e)) { error = e; return false; }
        if (!r.ok()) { error = jsonStr(r.body, "error"); if (error.empty()) error = "hwid reset failed"; return false; }
        error.clear();
        return true;
    }

    /** keep the session alive + refresh the license heartbeat */
    bool Ping() {
        if (token.empty()) return false;
        Response r; std::string e;
        return post("/api/loader/ping", "{\"app\":\"" + jsonEscape(app) + "\"" + productField() + "}",
                    token, r, e) && r.ok();
    }

    void Logout() {
        if (token.empty()) return;
        Response r; std::string e;
        post("/api/loader/logout", "{}", token, r, e);
        token.clear();
    }

    /** license expiry (epoch ms) reported by Login/Activate responses */
    static long long expiresAt(const std::string& loginJson) { return jsonNum(loginJson, "expires_at", 0); }
};

} // namespace apex
