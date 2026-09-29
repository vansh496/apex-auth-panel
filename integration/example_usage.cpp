/*
 * example_usage.cpp — how to wire the panel into an ImGui loader
 *
 * flow:
 *   1. BootCheck()      -> blocks the loader when the panel says
 *                          offline / maintenance (shows the panel message)
 *   2. Login()          -> username + password + HWID, stores session token
 *   3. Activate(key)    -> redeems the license and binds it to the machine
 *   4. Ping()           -> keep-alive, call every 60 seconds
 *
 * this file is a reference — copy the parts you need into your main.cpp
 */

#define VERSION_STRING "1.0.0"
#include "apex_auth.h"

#include <string>
#include <thread>
#include <atomic>
#include <chrono>

/* ---------------- panel connection ----------------
 * host + app slug hamesha chahiye; APP_SECRET tab chahiye jab panel me
 * Loaders → Credentials → "Require API secret" on ho, aur APP_PRODUCT tab
 * jab product-level secret on ho (panel → Product Credentials).          */
#define APP_SECRET  ""            // <- panel se copy karo (varna khali chhodo)
#define APP_PRODUCT ""            // <- jaise "Internal" (product secret on ho to)
static apex::Client g_auth("http://localhost:3000", "apex", APP_SECRET, APP_PRODUCT);
static std::atomic<bool> g_running{true};

enum class NodeState { Ready, Maintenance, Offline, Error };

/* called once, before the login window is shown */
static NodeState BootCheck(std::string& banner) {
    std::string state, version;
    bool ready = g_auth.Status(state, banner, version);

    if (ready) return NodeState::Ready;
    if (state == "maintenance") {
        if (banner.empty()) banner = "Server under maintenance, please try again later.";
        return NodeState::Maintenance;
    }
    if (state == "offline") {
        if (banner.empty()) banner = "Loader is offline.";
        return NodeState::Offline;
    }
    if (banner.empty()) banner = "Cannot reach the auth server.";
    return NodeState::Error;
}

/* returns an empty string on success, otherwise the panel error */
static std::string DoLogin(const std::string& user, const std::string& pass) {
    std::string err;
    if (!g_auth.Login(user, pass, apex::hwid(), err)) return err;
    return "";
}

static std::string RedeemKey(const std::string& key) {
    std::string err;
    if (!g_auth.Activate(key, apex::hwid(), err)) return err;
    return "";
}

/* keep-alive thread */
static void Heartbeat() {
    while (g_running) {
        std::this_thread::sleep_for(std::chrono::seconds(60));
        if (!g_auth.token.empty()) g_auth.Ping();
    }
}

/* =====================================================================
 *  ImGui glue — adapt to your UI
 * =====================================================================
#if defined(IMGUI_VERSION)
#include "imgui.h"

static std::string g_banner;
static NodeState   g_state = NodeState::Ready;
static char        g_user[64] = "", g_pass[64] = "", g_key[64] = "";
static std::string g_error;

void Loader_OnStart() {
    g_state = BootCheck(g_banner);
    std::thread(Heartbeat).detach();
}

void Loader_Draw() {
    if (g_state == NodeState::Maintenance || g_state == NodeState::Offline) {
        ImGui::BeginChild("node", ImVec2(0, 120), true);
        ImGui::PushStyleColor(ImGuiCol_Text,
            g_state == NodeState::Maintenance ? ImVec4(1.f, .75f, .25f, 1.f)
                                              : ImVec4(1.f, .35f, .45f, 1.f));
        ImGui::TextWrapped("%s", g_banner.c_str());
        ImGui::PopStyleColor();
        ImGui::EndChild();
        return;                       // <- block login / injection completely
    }

    ImGui::InputText("username", g_user, sizeof(g_user));
    ImGui::InputText("password", g_pass, sizeof(g_pass), ImGuiInputTextFlags_Password);
    if (ImGui::Button("Login")) {
        g_error = DoLogin(g_user, g_pass);
        if (!g_error.empty()) ImGui::OpenPopup("fail");
    }

    ImGui::InputText("license key", g_key, sizeof(g_key));
    if (ImGui::Button("Activate") && !g_auth.token.empty()) {
        g_error = RedeemKey(g_key);
        if (!g_error.empty()) ImGui::OpenPopup("fail");
    }

    if (ImGui::BeginPopupModal("fail", nullptr, ImGuiWindowFlags_AlwaysAutoResize)) {
        ImGui::TextWrapped("%s", g_error.c_str());
        if (ImGui::Button("OK")) ImGui::CloseCurrentPopup();
        ImGui::EndPopup();
    }
}
#endif
 * ===================================================================== */
