// Admin page application version identifier
const APP_VERSION = "1.0";

// Admin page logic: loads all profiles from admin.php and toggles Special group membership.
(function () {
    const API_URL = './api/admin.php';

    const messageCard = document.getElementById('messageCard');
    const messageTitle = document.getElementById('messageTitle');
    const messageText = document.getElementById('messageText');
    const userPanel = document.getElementById('userPanel');
    const userList = document.getElementById('userList');
    const emptyText = document.getElementById('emptyText');
    const searchInput = document.getElementById('userSearch');
    const toastEl = document.getElementById('toast');

    // Full user list from the server; the search box filters this client-side
    let allUsers = [];
    let toastTimer = null;

    document.getElementById('footerVersion').textContent = APP_VERSION;

    /**
     * Shows a brief toast message at the bottom of the screen.
     *
     * @param {string} text
     */
    function showToast(text) {
        toastEl.textContent = text;
        toastEl.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3000);
    }

    /**
     * Replaces the page content with a message card and hides the user list.
     *
     * @param {string} title
     * @param {string} text
     */
    function showMessage(title, text) {
        messageTitle.textContent = title;
        messageText.textContent = text;
        userPanel.hidden = true;
        messageCard.hidden = false;
    }

    /**
     * Calls admin.php with the signed-in session token.
     * Resolves with the parsed JSON body and the HTTP status; never throws on HTTP errors.
     *
     * @param {string} action - admin.php action name
     * @param {Object|null} body - JSON body for POST actions, or null for GET
     * @returns {Promise<{status: number, data: Object}>}
     */
    async function callApi(action, body) {
        const user = SuiteProfile.getUser();
        const url = API_URL + '?action=' + encodeURIComponent(action) + '&token=' + encodeURIComponent(user.token);
        const options = { headers: { 'Authorization': 'Bearer ' + user.token } };

        if (body) {
            options.method = 'POST';
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(Object.assign({ token: user.token }, body));
        }

        const res = await fetch(url, options);
        let data = {};
        try {
            data = await res.json();
        } catch (e) {
            data = { success: false, error: 'Unexpected server response.' };
        }
        return { status: res.status, data };
    }

    /**
     * Maps an admin.php access failure to a message card.
     *
     * @param {number} status
     * @param {Object} data
     */
    function showAccessError(status, data) {
        if (status === 401) {
            showMessage('Sign in required', 'Your session has expired. Return to the launcher and sign in again.');
        } else if (data.code === 'admin_password_required') {
            showMessage('Password required', 'Set a password on your profile to use admin tools.');
        } else if (data.code === 'forbidden') {
            showMessage('Admin access required', 'This profile does not have access to admin tools.');
        } else {
            showMessage('Unable to load admin tools', data.error || 'Please try again later.');
        }
    }

    /**
     * Formats a server timestamp as a short date, or a placeholder when missing.
     *
     * @param {string|null} value
     * @returns {string}
     */
    function formatDate(value) {
        if (!value) return 'never';
        const date = new Date(value.replace(' ', 'T') + 'Z');
        return isNaN(date.getTime()) ? value : date.toLocaleDateString();
    }

    /**
     * Builds one list row for a user: name, details, and a Special toggle (or Admin chip).
     *
     * @param {Object} user
     * @returns {HTMLLIElement}
     */
    function buildRow(user) {
        const row = document.createElement('li');
        row.className = 'user-row';

        const info = document.createElement('div');
        info.className = 'user-info';

        const name = document.createElement('div');
        name.className = 'user-name';
        name.textContent = user.username;
        if (user.hasPassword) {
            const lock = document.createElement('span');
            lock.className = 'lock-badge';
            lock.title = 'Password protected';
            lock.textContent = '🔒';
            name.appendChild(lock);
        }

        const meta = document.createElement('div');
        meta.className = 'user-meta';
        meta.textContent = 'Last login: ' + formatDate(user.lastLogin);

        info.appendChild(name);
        info.appendChild(meta);
        row.appendChild(info);

        if (user.groups.indexOf('admin') !== -1) {
            // Admins already have Special access, so they get a chip instead of a toggle
            const chip = document.createElement('span');
            chip.className = 'admin-chip';
            chip.textContent = 'Admin';
            row.appendChild(chip);
        } else {
            const isSpecial = user.groups.indexOf('special') !== -1;
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'toggle';
            toggle.setAttribute('role', 'switch');
            toggle.setAttribute('aria-checked', String(isSpecial));
            toggle.setAttribute('aria-label', 'Special access for ' + user.username);
            toggle.addEventListener('click', () => toggleSpecial(user, toggle));
            row.appendChild(toggle);
        }

        return row;
    }

    /**
     * Renders the user list, applying the current search filter.
     */
    function renderList() {
        const term = searchInput.value.trim().toLowerCase();
        const visible = allUsers.filter(u => u.username.toLowerCase().indexOf(term) !== -1);

        userList.textContent = '';
        visible.forEach(user => userList.appendChild(buildRow(user)));
        emptyText.hidden = visible.length > 0;
    }

    /**
     * Grants or revokes Special for a user based on the switch's current state.
     * The switch is disabled during the request and left unchanged if it fails.
     *
     * @param {Object} user
     * @param {HTMLButtonElement} toggle
     */
    async function toggleSpecial(user, toggle) {
        const turnOn = toggle.getAttribute('aria-checked') !== 'true';
        toggle.disabled = true;

        try {
            const { status, data } = await callApi(turnOn ? 'grant' : 'revoke', { userId: user.id, group: 'special' });
            if (!data.success) {
                if (status === 401 || status === 403) {
                    showAccessError(status, data);
                } else {
                    showToast(data.error || 'Unable to update this user.');
                }
                return;
            }

            // Replace the cached record with the server's updated copy
            const index = allUsers.findIndex(u => u.id === user.id);
            if (index !== -1) allUsers[index] = data.user;
            toggle.setAttribute('aria-checked', String(turnOn));
            showToast(user.username + (turnOn ? ' added to Special' : ' removed from Special'));
        } catch (err) {
            showToast('Network error. Change was not saved.');
        } finally {
            toggle.disabled = false;
        }
    }

    /**
     * Loads all users from the server and shows the management list.
     */
    async function loadUsers() {
        try {
            const { status, data } = await callApi('list_users', null);
            if (!data.success) {
                showAccessError(status, data);
                return;
            }
            allUsers = data.users;
            messageCard.hidden = true;
            userPanel.hidden = false;
            renderList();
        } catch (err) {
            showMessage('Unable to load admin tools', 'Could not reach the server. Check your connection and try again.');
        }
    }

    /**
     * Entry point: checks connection and sign-in state before requesting data.
     */
    function init() {
        if (!window.SuiteProfile || SuiteProfile.isGuest()) {
            showMessage('Sign in required', 'Sign in from the launcher to use admin tools.');
            return;
        }
        if (!navigator.onLine) {
            showMessage('Offline', 'Admin tools need a connection.');
            return;
        }
        loadUsers();
    }

    searchInput.addEventListener('input', renderList);
    init();
})();
