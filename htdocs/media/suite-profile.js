// WebAppSuite Profile & Cloud Sync Client Library
// Provides seamless offline-first user profile management and background cloud sync.

// Library version identifier
const SUITE_PROFILE_VERSION = '1.1';

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.SuiteProfile = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    const STORAGE_KEY = 'webappsuite_profile_session';
    let saveTimeout = null;

    /**
     * Determines relative path to the api directory based on current URL path.
     *
     * @param {string} endpoint - API file name
     * @returns {string} Relative path to endpoint
     */
    function getApiUrl(endpoint = 'profile.php') {
        const path = window.location.pathname;
        // If in a sub-app folder (e.g. /ScoreKeeper/, /Bingo/)
        const depth = (path.match(/\//g) || []).length;
        if (path.indexOf('/ScoreKeeper') !== -1 ||
            path.indexOf('/Bingo') !== -1 ||
            path.indexOf('/BagScore') !== -1 ||
            path.indexOf('/DriverScore') !== -1 ||
            path.indexOf('/FarkleScore') !== -1 ||
            path.indexOf('/HarleyVinDecoder') !== -1) {
            return '../api/' + endpoint;
        }
        return './api/' + endpoint;
    }

    /**
     * Retrieves stored user session from localStorage.
     *
     * @returns {Object|null}
     */
    function getUser() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Checks if current user is browsing as a guest.
     *
     * @returns {boolean}
     */
    function isGuest() {
        const user = getUser();
        return !user || !user.token;
    }

    /**
     * Saves user session to localStorage and triggers profile change event.
     *
     * @param {Object|null} session
     */
    function setSession(session) {
        if (session) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
        window.dispatchEvent(new CustomEvent('suite-profile-changed', { detail: session }));
    }

    /**
     * Logs in or creates a profile with username and optional password.
     *
     * @param {string} username
     * @param {string} [password='']
     * @returns {Promise<Object>}
     */
    async function login(username, password = '') {
        const url = getApiUrl('profile.php') + '?action=auth';
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username.trim(), password })
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Authentication failed');
        }

        const session = {
            username: data.username,
            token: data.token,
            hasPassword: !!data.hasPassword
        };
        setSession(session);
        return session;
    }

    /**
     * Logs out the current user and returns to guest mode.
     */
    function logout() {
        setSession(null);
    }

    /**
     * Sets or updates password for the currently logged in profile.
     *
     * @param {string} newPassword
     * @returns {Promise<boolean>}
     */
    async function setPassword(newPassword) {
        const user = getUser();
        if (!user || !user.token) {
            throw new Error('You must be logged in to set a password.');
        }

        const url = getApiUrl('profile.php') + '?action=set_password&token=' + encodeURIComponent(user.token);
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + user.token
            },
            body: JSON.stringify({ token: user.token, newPassword })
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Failed to update password');
        }

        user.hasPassword = true;
        setSession(user);
        return true;
    }

    /**
     * Loads remote settings payload for a specific app if logged in.
     *
     * @param {string} appId
     * @returns {Promise<Object|null>}
     */
    async function loadAppData(appId) {
        const user = getUser();
        if (!user || !user.token || !navigator.onLine) {
            return null;
        }

        try {
            const url = getApiUrl('profile.php') + '?action=load&app=' + encodeURIComponent(appId) + '&token=' + encodeURIComponent(user.token);
            const res = await fetch(url, {
                headers: { 'Authorization': 'Bearer ' + user.token }
            });
            if (!res.ok) return null;
            const payload = await res.json();
            return payload.success ? payload.data : null;
        } catch (err) {
            console.warn('Could not load remote profile data for ' + appId + ':', err);
            return null;
        }
    }

    /**
     * Saves app data payload to cloud with debouncing if logged in.
     *
     * @param {string} appId
     * @param {Object} data
     * @param {number} [delayMs=1000]
     */
    function saveAppData(appId, data, delayMs = 1000) {
        const user = getUser();
        if (!user || !user.token || !navigator.onLine) {
            return;
        }

        window.dispatchEvent(new CustomEvent('suite-sync-state', { detail: { state: 'syncing', app: appId } }));

        if (saveTimeout) {
            clearTimeout(saveTimeout);
        }

        saveTimeout = setTimeout(async () => {
            try {
                const url = getApiUrl('profile.php') + '?action=save&app=' + encodeURIComponent(appId) + '&token=' + encodeURIComponent(user.token);
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + user.token
                    },
                    body: JSON.stringify({ token: user.token, data })
                });
                const result = await res.json();
                if (res.ok && result.success) {
                    window.dispatchEvent(new CustomEvent('suite-sync-state', { detail: { state: 'synced', app: appId } }));
                } else {
                    window.dispatchEvent(new CustomEvent('suite-sync-state', { detail: { state: 'error', app: appId } }));
                }
            } catch (e) {
                window.dispatchEvent(new CustomEvent('suite-sync-state', { detail: { state: 'error', app: appId } }));
            }
        }, delayMs);
    }

    /**
     * Renders a subtle status indicator in sub-app footers.
     *
     * @param {HTMLElement} containerEl
     */
    function renderFooterIndicator(containerEl) {
        if (!containerEl) return;

        let badge = containerEl.querySelector('.suite-footer-profile');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'suite-footer-profile';
            containerEl.appendChild(badge);
        }

        function updateBadge() {
            const user = getUser();
            if (user && user.token) {
                badge.innerHTML = `👤 ${escapeHtml(user.username)} <span class="suite-cloud-icon suite-sync-state-ok" title="Settings synced to cloud">☁️</span>`;
            } else {
                badge.innerHTML = `<span class="suite-sync-state-guest" title="Local cache only">👤 Guest (local)</span>`;
            }
        }

        updateBadge();
        window.addEventListener('suite-profile-changed', updateBadge);
        window.addEventListener('suite-sync-state', (e) => {
            const user = getUser();
            if (!user) return;
            const icon = badge.querySelector('.suite-cloud-icon');
            if (icon) {
                if (e.detail.state === 'syncing') {
                    icon.style.opacity = '0.5';
                    icon.title = 'Syncing...';
                } else if (e.detail.state === 'synced') {
                    icon.style.opacity = '1';
                    icon.title = 'Settings synced to cloud';
                } else {
                    icon.title = 'Offline or sync pending';
                }
            }
        });
    }

    /**
     * Mounts the floating profile avatar button and modal on the main launcher page.
     *
     * @param {HTMLElement} containerEl
     */
    function mountLauncherProfileButton(containerEl) {
        if (!containerEl) return;

        containerEl.innerHTML = '';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'suite-profile-btn';
        containerEl.appendChild(btn);

        // Inject modal backdrop if not present
        let backdrop = document.getElementById('suiteProfileModalBackdrop');
        if (!backdrop) {
            backdrop = document.createElement('div');
            backdrop.id = 'suiteProfileModalBackdrop';
            backdrop.className = 'suite-modal-backdrop';
            backdrop.innerHTML = `
                <div class="suite-modal" role="dialog" aria-modal="true" aria-labelledby="suiteModalTitle">
                    <div class="suite-modal-header">
                        <h3 id="suiteModalTitle">User Profile</h3>
                        <button type="button" class="suite-modal-close" id="suiteModalClose" aria-label="Close">&times;</button>
                    </div>
                    <div class="suite-modal-body" id="suiteModalBody"></div>
                </div>
            `;
            document.body.appendChild(backdrop);

            backdrop.addEventListener('click', (e) => {
                if (e.target === backdrop) closeModal();
            });
            document.getElementById('suiteModalClose').addEventListener('click', closeModal);
        }

        function openModal() {
            renderModalContent();
            backdrop.classList.add('open');
        }

        function closeModal() {
            backdrop.classList.remove('open');
        }

        function updateButton() {
            const user = getUser();
            if (user && user.token) {
                btn.className = 'suite-profile-btn logged-in';
                const initial = user.username.charAt(0).toUpperCase();
                btn.innerHTML = `
                    <div class="suite-profile-avatar">${initial}</div>
                    <span>${escapeHtml(user.username)}</span>
                    <span class="suite-profile-status-dot" title="Cloud Active"></span>
                `;
            } else {
                btn.className = 'suite-profile-btn';
                btn.innerHTML = `
                    <div class="suite-profile-avatar">👤</div>
                    <span>Sign In</span>
                    <span class="suite-profile-status-dot" title="Guest Mode"></span>
                `;
            }
        }

        function renderModalContent() {
            const user = getUser();
            const body = document.getElementById('suiteModalBody');

            if (user && user.token) {
                // Logged in profile view
                body.innerHTML = `
                    <div id="suiteModalMsg" class="suite-modal-msg"></div>
                    <div style="margin-bottom: 18px; text-align: center;">
                        <div class="suite-profile-avatar" style="width: 48px; height: 48px; font-size: 20px; margin: 0 auto 10px; background: #34a853; color: white;">
                            ${user.username.charAt(0).toUpperCase()}
                        </div>
                        <h4 style="margin: 0 0 4px; font-size: 16px;">${escapeHtml(user.username)}</h4>
                        <span style="font-size: 13px; color: #5f6368;">
                            ${user.hasPassword ? '🔒 Password Protected Profile' : '🔓 Open Profile (No Password)'}
                        </span>
                    </div>

                    <div style="background: #f8f9fa; border: 1px solid #dadce0; border-radius: 8px; padding: 12px; margin-bottom: 16px; font-size: 13px; line-height: 1.4;">
                        Your settings, themes, and game configurations in ScoreKeeper and Bingo automatically sync with this profile.
                    </div>

                    <div id="suiteSetPasswordSection" style="margin-bottom: 16px; border-top: 1px solid #e8eaed; padding-top: 14px;">
                        <label style="display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px;">
                            ${user.hasPassword ? 'Update Password' : 'Add Password to Lock Profile'}
                        </label>
                        <div style="display: flex; gap: 8px;">
                            <input type="password" id="suiteNewPasswordInput" placeholder="New password or PIN" style="flex: 1; padding: 8px 10px; border: 1px solid #dadce0; border-radius: 6px; font-size: 14px;">
                            <button type="button" id="suiteSavePasswordBtn" class="suite-btn-secondary" style="padding: 8px 12px; font-size: 13px;">Save</button>
                        </div>
                        <div class="suite-form-help">Protects your username from being synced by others.</div>
                    </div>

                    <div class="suite-modal-footer" style="padding: 0; margin-top: 16px;">
                        <button type="button" id="suiteLogoutBtn" class="suite-btn-secondary" style="color: #c5221f; border-color: #fad2cf;">
                            Sign Out (Switch to Guest)
                        </button>
                    </div>
                `;

                document.getElementById('suiteLogoutBtn').addEventListener('click', () => {
                    logout();
                    closeModal();
                });

                document.getElementById('suiteSavePasswordBtn').addEventListener('click', async () => {
                    const input = document.getElementById('suiteNewPasswordInput');
                    const msg = document.getElementById('suiteModalMsg');
                    const val = input.value.trim();
                    if (!val) return;

                    try {
                        await setPassword(val);
                        msg.className = 'suite-modal-msg success';
                        msg.textContent = 'Password saved successfully!';
                        input.value = '';
                        setTimeout(renderModalContent, 1000);
                    } catch (err) {
                        msg.className = 'suite-modal-msg error';
                        msg.textContent = err.message;
                    }
                });

            } else {
                // Guest sign in / create profile form
                body.innerHTML = `
                    <div id="suiteModalMsg" class="suite-modal-msg"></div>
                    <p style="font-size: 13px; color: #5f6368; margin-top: 0; margin-bottom: 16px;">
                        Sign in or create a profile to sync your preferences and settings across devices. No email required.
                    </p>

                    <form id="suiteLoginForm">
                        <div class="suite-form-group">
                            <label for="suiteUsernameInput">Username</label>
                            <input type="text" id="suiteUsernameInput" placeholder="e.g. scuba_scott" autocomplete="username" required>
                            <div class="suite-form-help">Letters, numbers, hyphens, underscores (2-50 chars).</div>
                        </div>

                        <div class="suite-form-group">
                            <label for="suitePasswordInput">Password / PIN (Optional)</label>
                            <input type="password" id="suitePasswordInput" placeholder="Optional for public profile" autocomplete="current-password">
                            <div class="suite-form-help">Leave empty if you don't need a password.</div>
                        </div>

                        <div class="suite-modal-footer" style="padding: 12px 0 0;">
                            <button type="button" class="suite-btn-secondary" id="suiteCancelBtn">Stay as Guest</button>
                            <button type="submit" class="suite-btn-primary" id="suiteSubmitBtn">Sign In / Register</button>
                        </div>
                    </form>
                `;

                document.getElementById('suiteCancelBtn').addEventListener('click', closeModal);

                document.getElementById('suiteLoginForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const u = document.getElementById('suiteUsernameInput').value.trim();
                    const p = document.getElementById('suitePasswordInput').value;
                    const msg = document.getElementById('suiteModalMsg');
                    const submitBtn = document.getElementById('suiteSubmitBtn');

                    submitBtn.disabled = true;
                    submitBtn.textContent = 'Connecting...';

                    try {
                        await login(u, p);
                        closeModal();
                    } catch (err) {
                        msg.className = 'suite-modal-msg error';
                        msg.textContent = err.message;
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Sign In / Register';
                    }
                });
            }
        }

        btn.addEventListener('click', openModal);
        updateButton();
        window.addEventListener('suite-profile-changed', updateButton);
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    return {
        VERSION: SUITE_PROFILE_VERSION,
        getUser,
        isGuest,
        login,
        logout,
        setPassword,
        loadAppData,
        saveAppData,
        renderFooterIndicator,
        mountLauncherProfileButton
    };
}));
