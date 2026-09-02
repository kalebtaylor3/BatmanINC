/*
  Batman Reading Tracker — Cross-device cloud sync
  -------------------------------------------------
  Works with the existing tracker HTML that already defines:
    - progress
    - saveProgress(progress)
    - render()

  Setup:
  1) Create a Supabase project.
  2) Run the SQL provided by ChatGPT to create public.batman_progress.
  3) Paste your Project URL + PUBLISHABLE/ANON key below.
  4) Add these immediately before </body>, AFTER your existing tracker <script>:

     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="sync.js"></script>

  IMPORTANT:
  - Use only the public/publishable (anon) key here.
  - NEVER put a service_role key in a public GitHub repository.
*/

(() => {
  "use strict";

  // ==========================================================
  // EDIT THESE TWO VALUES
  // ==========================================================
  const SUPABASE_URL = "PASTE_YOUR_SUPABASE_PROJECT_URL_HERE";
  const SUPABASE_KEY = "PASTE_YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY_HERE";
  // ==========================================================

  const TABLE = "batman_progress";
  const SAVE_DELAY_MS = 350;

  if (
    !SUPABASE_URL ||
    !SUPABASE_KEY ||
    SUPABASE_URL.includes("PASTE_") ||
    SUPABASE_KEY.includes("PASTE_")
  ) {
    console.warn("[Batman Sync] Add your Supabase URL and public key to sync.js.");
    return;
  }

  if (!window.supabase?.createClient) {
    console.error(
      "[Batman Sync] Supabase library not loaded. Add the Supabase CDN script before sync.js."
    );
    return;
  }

  // Your original page already defines these.
  if (
    typeof saveProgress !== "function" ||
    typeof render !== "function" ||
    typeof progress === "undefined"
  ) {
    console.error(
      "[Batman Sync] Could not find progress/saveProgress/render in the tracker HTML."
    );
    return;
  }

  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });

  // Preserve your existing localStorage save as an offline fallback.
  const saveLocal = saveProgress;

  let currentUser = null;
  let cloudRowExists = false;
  let saveTimer = null;
  let loadingCloud = false;
  let lastCloudJson = "";

  // ----------------------------------------------------------
  // Small login / sync status panel injected into your page
  // ----------------------------------------------------------
  const panel = document.createElement("div");
  panel.id = "cloudSyncPanel";
  panel.style.cssText = `
    margin: 14px 0 20px;
    padding: 14px 16px;
    border: 1px solid #2a313c;
    border-radius: 14px;
    background: #13171d;
    color: #f3f4f6;
    font-family: inherit;
  `;

  panel.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <strong style="color:#f4d35e;">☁ Cloud Sync</strong>
      <span id="cloudSyncStatus" style="color:#a7b0be;font-size:13px;">
        Checking sign-in…
      </span>
    </div>

    <div id="cloudLoggedOut" style="margin-top:10px;display:none;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <input
          id="cloudEmail"
          type="email"
          autocomplete="email"
          placeholder="your@email.com"
          style="
            flex:1 1 220px;
            min-width:0;
            border:1px solid #2a313c;
            border-radius:10px;
            background:#0b0d10;
            color:#f3f4f6;
            padding:10px 12px;
            font:inherit;
          "
        >
        <button id="cloudLoginBtn" type="button">
          Email me a sign-in link
        </button>
      </div>
      <div id="cloudLoginMessage"
           style="margin-top:8px;color:#a7b0be;font-size:12px;"></div>
    </div>

    <div id="cloudLoggedIn"
         style="margin-top:10px;display:none;align-items:center;gap:8px;flex-wrap:wrap;">
      <span id="cloudUser"
            style="color:#a7b0be;font-size:13px;"></span>
      <button id="cloudRefreshBtn" type="button">Sync Now</button>
      <button id="cloudLogoutBtn" type="button">Sign Out</button>
    </div>
  `;

  const toolbar = document.querySelector(".toolbar");
  if (toolbar?.parentNode) {
    toolbar.parentNode.insertBefore(panel, toolbar);
  } else {
    document.body.prepend(panel);
  }

  const statusEl = panel.querySelector("#cloudSyncStatus");
  const loggedOutEl = panel.querySelector("#cloudLoggedOut");
  const loggedInEl = panel.querySelector("#cloudLoggedIn");
  const emailEl = panel.querySelector("#cloudEmail");
  const loginBtn = panel.querySelector("#cloudLoginBtn");
  const loginMessageEl = panel.querySelector("#cloudLoginMessage");
  const cloudUserEl = panel.querySelector("#cloudUser");
  const refreshBtn = panel.querySelector("#cloudRefreshBtn");
  const logoutBtn = panel.querySelector("#cloudLogoutBtn");

  function setStatus(text, ok = false) {
    statusEl.textContent = text;
    statusEl.style.color = ok ? "#9ed7ad" : "#a7b0be";
  }

  function showLoggedOut() {
    loggedOutEl.style.display = "block";
    loggedInEl.style.display = "none";
    currentUser = null;
    setStatus("Not signed in — progress is only on this device.");
  }

  function showLoggedIn(user) {
    loggedOutEl.style.display = "none";
    loggedInEl.style.display = "flex";
    cloudUserEl.textContent = user.email ? `Signed in as ${user.email}` : "Signed in";
  }

  function cloneProgress() {
    // Progress in your tracker is a plain object with issue order => bool.
    return JSON.parse(JSON.stringify(progress || {}));
  }

  // ----------------------------------------------------------
  // Cloud load / save
  // ----------------------------------------------------------
  async function loadFromCloud({ force = false } = {}) {
    if (!currentUser || loadingCloud) return;

    loadingCloud = true;
    setStatus("Loading cloud progress…");

    try {
      const { data, error } = await db
        .from(TABLE)
        .select("progress,updated_at")
        .eq("user_id", currentUser.id)
        .maybeSingle();

      if (error) throw error;

      if (data?.progress) {
        cloudRowExists = true;

        const cloudProgress = data.progress || {};
        const cloudJson = JSON.stringify(cloudProgress);

        // Cloud is authoritative once the user already has a cloud row.
        // This prevents a fresh laptop with empty localStorage from wiping
        // progress made earlier on the PC.
        if (force || cloudJson !== lastCloudJson) {
          progress = cloudProgress;
          saveLocal(progress);
          lastCloudJson = cloudJson;
          render();
        }

        setStatus("Synced ✓", true);
      } else {
        // First-ever cloud sync: upload this device's existing local progress,
        // so you don't lose the checkmarks you already made.
        cloudRowExists = false;
        await saveToCloud(cloneProgress(), true);
      }
    } catch (err) {
      console.error("[Batman Sync] Load failed:", err);
      setStatus("Cloud unavailable — using local progress.");
    } finally {
      loadingCloud = false;
    }
  }

  async function saveToCloud(snapshot, immediate = false) {
    if (!currentUser) return;

    try {
      setStatus("Saving…");

      const payload = {
        user_id: currentUser.id,
        progress: snapshot,
        updated_at: new Date().toISOString()
      };

      const { error } = await db
        .from(TABLE)
        .upsert(payload, { onConflict: "user_id" });

      if (error) throw error;

      cloudRowExists = true;
      lastCloudJson = JSON.stringify(snapshot);
      setStatus("Synced ✓", true);
    } catch (err) {
      console.error("[Batman Sync] Save failed:", err);
      setStatus("Save failed — kept locally, will retry.");
    }
  }

  function queueCloudSave(snapshot) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveToCloud(snapshot);
    }, SAVE_DELAY_MS);
  }

  // ----------------------------------------------------------
  // Replace the original saveProgress function.
  //
  // Your existing checkbox handler already calls saveProgress(progress),
  // so we don't need to rewrite the tracker itself.
  // ----------------------------------------------------------
  saveProgress = function syncedSaveProgress(newProgress) {
    // Always save to localStorage too, so the page still works offline.
    saveLocal(newProgress);

    if (currentUser) {
      queueCloudSave(JSON.parse(JSON.stringify(newProgress || {})));
    }
  };

  // ----------------------------------------------------------
  // Authentication
  // ----------------------------------------------------------
  loginBtn.addEventListener("click", async () => {
    const email = emailEl.value.trim();

    if (!email) {
      loginMessageEl.textContent = "Enter your email first.";
      return;
    }

    loginBtn.disabled = true;
    loginMessageEl.textContent = "Sending sign-in link…";

    // Return to this exact GitHub Pages path.
    const redirectTo =
      window.location.origin +
      window.location.pathname.replace(/\/[^/]*\.html$/, "/");

    const { error } = await db.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectTo
      }
    });

    loginBtn.disabled = false;

    if (error) {
      console.error("[Batman Sync] Login error:", error);
      loginMessageEl.textContent = error.message;
      return;
    }

    loginMessageEl.textContent =
      "Check your email and open the sign-in link on this device.";
  });

  emailEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loginBtn.click();
  });

  logoutBtn.addEventListener("click", async () => {
    await db.auth.signOut();
    showLoggedOut();
  });

  refreshBtn.addEventListener("click", () => {
    loadFromCloud({ force: true });
  });

  db.auth.onAuthStateChange((_event, session) => {
    const user = session?.user ?? null;

    if (!user) {
      showLoggedOut();
      return;
    }

    currentUser = user;
    showLoggedIn(user);

    // Run outside the auth callback stack.
    setTimeout(() => loadFromCloud({ force: true }), 0);
  });

  // When you switch back to this tab/device, pull the latest cloud state.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && currentUser) {
      loadFromCloud();
    }
  });

  // If you checked boxes while temporarily offline, retry when connected.
  window.addEventListener("online", () => {
    if (currentUser) {
      saveToCloud(cloneProgress());
    }
  });

  // Initial session check.
  (async () => {
    const {
      data: { session },
      error
    } = await db.auth.getSession();

    if (error) {
      console.error("[Batman Sync] Session check failed:", error);
      showLoggedOut();
      return;
    }

    if (session?.user) {
      currentUser = session.user;
      showLoggedIn(currentUser);
      await loadFromCloud({ force: true });
    } else {
      showLoggedOut();
    }
  })();
})();
