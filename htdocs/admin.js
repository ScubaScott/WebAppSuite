// Admin page application version identifier
const APP_VERSION = "1.3";

// Admin page logic: loads all profiles from admin.php, toggles Special group membership, manages user passwords, and renders system stats.
(function () {
    const API_URL = './api/admin.php';

    const messageCard = document.getElementById('messageCard');
    const messageTitle = document.getElementById('messageTitle');
    const messageText = document.getElementById('messageText');
    const userPanel = document.getElementById('userPanel');
    const userCountBadge = document.getElementById('userCountBadge');
    const userList = document.getElementById('userList');
    const emptyText = document.getElementById('emptyText');
    const searchInput = document.getElementById('userSearch');
    const toastEl = document.getElementById('toast');

    // Pagination elements for 10-user display limit
    const PAGE_SIZE = 10;
    let currentPage = 1;
    const userPagination = document.getElementById('userPagination');
    const prevPageBtn = document.getElementById('prevPageBtn');
    const nextPageBtn = document.getElementById('nextPageBtn');
    const pageInfo = document.getElementById('pageInfo');

    // Stats panel and metric dashboard elements
    const statsPanel = document.getElementById('statsPanel');
    const statsLoading = document.getElementById('statsLoading');
    const statsGrid = document.getElementById('statsGrid');
    const statsError = document.getElementById('statsError');
    const statsErrorText = document.getElementById('statsErrorText');
    const refreshStatsBtn = document.getElementById('refreshStatsBtn');
    const retryStatsBtn = document.getElementById('retryStatsBtn');

    const statTotalUsers = document.getElementById('statTotalUsers');
    const statUsersSub = document.getElementById('statUsersSub');
    const statActiveSessions = document.getElementById('statActiveSessions');
    const statScoreboardGames = document.getElementById('statScoreboardGames');
    const statScoreboardSub = document.getElementById('statScoreboardSub');
    const statBingoCards = document.getElementById('statBingoCards');
    const statBingoGames = document.getElementById('statBingoGames');
    const statCloudSync = document.getElementById('statCloudSync');
    const statCloudSyncSub = document.getElementById('statCloudSyncSub');
    const statDbSize = document.getElementById('statDbSize');
    const statDbSub = document.getElementById('statDbSub');
    const statSpecialUsers = document.getElementById('statSpecialUsers');

    // Password management modal elements
    const passwordModal = document.getElementById('passwordModal');
    const modalCloseBtn = document.getElementById('modalCloseBtn');
    const modalUsername = document.getElementById('modalUsername');
    const modalPasswordStatus = document.getElementById('modalPasswordStatus');
    const resetPasswordForm = document.getElementById('resetPasswordForm');
    const adminNewPassword = document.getElementById('adminNewPassword');
    const generatePasswordBtn = document.getElementById('generatePasswordBtn');
    const savePasswordBtn = document.getElementById('savePasswordBtn');
    const removePasswordBtn = document.getElementById('removePasswordBtn');
    const removeSelfNotice = document.getElementById('removeSelfNotice');

    // Full user list from the server; the search box filters this client-side
    let allUsers = [];
    let activeUser = null;
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
        statsPanel.hidden = true;
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
     * Generates an easy-to-read random temporary password.
     *
     * @returns {string}
     */
    function generateRandomPassword() {
        const words = ['Pass', 'Blue', 'Star', 'Safe', 'Gate', 'Key', 'Lock', 'Port'];
        const word = words[Math.floor(Math.random() * words.length)];
        const num = Math.floor(1000 + Math.random() * 9000);
        return word + '-' + num;
    }

    /**
     * Opens the password management modal dialog for the selected user.
     *
     * @param {Object} user
     */
    function openPasswordModal(user) {
        activeUser = user;
        modalUsername.textContent = user.username;

        if (user.hasPassword) {
            modalPasswordStatus.textContent = '🔒 Has Password';
            modalPasswordStatus.className = 'status-chip status-locked';
        } else {
            modalPasswordStatus.textContent = '🔓 No Password';
            modalPasswordStatus.className = 'status-chip status-unlocked';
        }

        adminNewPassword.value = '';

        // Prevent the logged-in admin from removing the password from their own profile
        const currentAdmin = SuiteProfile.getUser();
        const isSelf = currentAdmin && currentAdmin.username && currentAdmin.username.toLowerCase() === user.username.toLowerCase();

        if (isSelf) {
            removePasswordBtn.disabled = true;
            removePasswordBtn.title = 'You cannot remove the password from your own admin account';
            removeSelfNotice.hidden = false;
        } else if (!user.hasPassword) {
            removePasswordBtn.disabled = true;
            removePasswordBtn.title = 'User does not currently have a password';
            removeSelfNotice.hidden = true;
        } else {
            removePasswordBtn.disabled = false;
            removePasswordBtn.title = '';
            removeSelfNotice.hidden = true;
        }

        passwordModal.hidden = false;
        adminNewPassword.focus();
    }

    /**
     * Closes the password management modal dialog and resets state.
     */
    function closePasswordModal() {
        passwordModal.hidden = true;
        activeUser = null;
        adminNewPassword.value = '';
    }

    /**
     * Handles resetting the password for the active modal user.
     *
     * @param {Event} e
     */
    async function submitResetPassword(e) {
        e.preventDefault();
        if (!activeUser) return;

        const newPassword = adminNewPassword.value.trim();
        if (newPassword.length < 3) {
            showToast('Password must be at least 3 characters.');
            return;
        }

        savePasswordBtn.disabled = true;

        try {
            const { status, data } = await callApi('reset_password', {
                userId: activeUser.id,
                newPassword: newPassword
            });

            if (!data.success) {
                if (status === 401 || status === 403) {
                    showAccessError(status, data);
                } else {
                    showToast(data.error || 'Failed to reset password.');
                }
                return;
            }

            // Update user record in cached allUsers list
            const index = allUsers.findIndex(u => u.id === activeUser.id);
            if (index !== -1) {
                allUsers[index] = data.user;
            }

            const targetUsername = activeUser.username;
            closePasswordModal();
            renderList();
            showToast('Password updated for ' + targetUsername);
        } catch (err) {
            showToast('Network error. Password was not updated.');
        } finally {
            savePasswordBtn.disabled = false;
        }
    }

    /**
     * Handles removing password protection from the active modal user.
     */
    async function handleRemovePassword() {
        if (!activeUser || removePasswordBtn.disabled) return;

        const targetUsername = activeUser.username;
        const confirmed = window.confirm('Remove password protection for "' + targetUsername + '"? Anyone will be able to access this profile without a password.');
        if (!confirmed) return;

        removePasswordBtn.disabled = true;

        try {
            const { status, data } = await callApi('remove_password', {
                userId: activeUser.id
            });

            if (!data.success) {
                if (status === 401 || status === 403) {
                    showAccessError(status, data);
                } else {
                    showToast(data.error || 'Failed to remove password.');
                }
                return;
            }

            // Update user record in cached allUsers list
            const index = allUsers.findIndex(u => u.id === activeUser.id);
            if (index !== -1) {
                allUsers[index] = data.user;
            }

            closePasswordModal();
            renderList();
            showToast('Password removed for ' + targetUsername);
        } catch (err) {
            showToast('Network error. Password was not removed.');
        } finally {
            removePasswordBtn.disabled = false;
        }
    }

    /**
     * Builds one list row for a user: name, details, Special toggle (or Admin chip), and Password button.
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
        meta.textContent = 'Last active: ' + formatDate(user.lastActive || user.lastLogin);

        info.appendChild(name);
        info.appendChild(meta);
        row.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'user-actions';

        if (user.groups.indexOf('admin') !== -1) {
            // Admins already have Special access, so they get a chip instead of a toggle
            const chip = document.createElement('span');
            chip.className = 'admin-chip';
            chip.textContent = 'Admin';
            actions.appendChild(chip);
        } else {
            const isSpecial = user.groups.indexOf('special') !== -1;
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'toggle';
            toggle.setAttribute('role', 'switch');
            toggle.setAttribute('aria-checked', String(isSpecial));
            toggle.setAttribute('aria-label', 'Special access for ' + user.username);
            toggle.addEventListener('click', () => toggleSpecial(user, toggle));
            actions.appendChild(toggle);
        }

        // Button to open password reset and removal options
        const pwdBtn = document.createElement('button');
        pwdBtn.type = 'button';
        pwdBtn.className = 'btn-pwd';
        pwdBtn.setAttribute('aria-label', 'Manage password for ' + user.username);
        pwdBtn.title = 'Reset or remove password';

        const pwdIcon = document.createElement('span');
        pwdIcon.className = 'btn-pwd-icon';
        pwdIcon.textContent = '🔑';

        const pwdText = document.createElement('span');
        pwdText.className = 'btn-pwd-text';
        pwdText.textContent = 'Password';

        pwdBtn.appendChild(pwdIcon);
        pwdBtn.appendChild(pwdText);
        pwdBtn.addEventListener('click', () => openPasswordModal(user));
        actions.appendChild(pwdBtn);

        row.appendChild(actions);

        return row;
    }

    /**
     * Renders the user list, applying the current search filter and pagination limit of 10 users.
     */
    function renderList() {
        const term = searchInput.value.trim().toLowerCase();
        const visible = allUsers.filter(u => u.username.toLowerCase().indexOf(term) !== -1);

        userCountBadge.textContent = allUsers.length;
        userList.textContent = '';

        if (visible.length === 0) {
            emptyText.hidden = false;
            userPagination.hidden = true;
            return;
        }

        emptyText.hidden = true;

        // Calculate pages and clamp current page index
        const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
        if (currentPage > totalPages) {
            currentPage = totalPages;
        }
        if (currentPage < 1) {
            currentPage = 1;
        }

        // Slice subset of at most 10 users for display
        const startIndex = (currentPage - 1) * PAGE_SIZE;
        const pageUsers = visible.slice(startIndex, startIndex + PAGE_SIZE);

        pageUsers.forEach(user => userList.appendChild(buildRow(user)));

        // Update pagination status and button enabled states
        userPagination.hidden = false;
        pageInfo.textContent = 'Page ' + currentPage + ' of ' + totalPages + ' (' + visible.length + ' users)';
        prevPageBtn.disabled = currentPage <= 1;
        nextPageBtn.disabled = currentPage >= totalPages;
    }

    /**
     * Loads live database metrics and application statistics from the server.
     */
    async function loadStats() {
        statsLoading.hidden = false;
        statsGrid.hidden = true;
        statsError.hidden = true;
        refreshStatsBtn.disabled = true;

        try {
            const { status, data } = await callApi('stats', null);
            if (!data.success || !data.stats) {
                statsLoading.hidden = true;
                statsError.hidden = false;
                statsErrorText.textContent = data.error || 'Failed to retrieve statistics.';
                return;
            }

            const s = data.stats;

            // Total users and active breakdown
            statTotalUsers.textContent = Number(s.users.total).toLocaleString();
            statUsersSub.textContent = Number(s.users.active30d).toLocaleString() + ' active (30d) • ' + Number(s.users.passwordProtected).toLocaleString() + ' protected';

            // Active sessions (logged-in devices / unique visitors)
            statActiveSessions.textContent = Number(s.sessions.active).toLocaleString();

            // Scoreboard Games count
            statScoreboardGames.textContent = Number(s.scoreboard.total).toLocaleString();
            statScoreboardSub.textContent = Number(s.scoreboard.live).toLocaleString() + ' live • ' + Number(s.scoreboard.final).toLocaleString() + ' final';

            // Bingo Cards in library
            statBingoCards.textContent = Number(s.bingo.cards).toLocaleString();

            // Bingo Games (game modes excluding patterns)
            statBingoGames.textContent = Number(s.bingo.games).toLocaleString();

            // User App Data cloud sync records
            statCloudSync.textContent = Number(s.userData.totalRecords).toLocaleString();
            statCloudSyncSub.textContent = Number(s.userData.syncedApps).toLocaleString() + ' distinct apps synced';

            // Database storage size and table count
            statDbSize.textContent = s.database.sizeFormatted || '0 B';
            statDbSub.textContent = 'Across ' + Number(s.database.tableCount).toLocaleString() + ' tables';

            // Special & Admin users
            statSpecialUsers.textContent = Number(s.users.special).toLocaleString() + ' / ' + Number(s.users.admin).toLocaleString();

            statsLoading.hidden = true;
            statsGrid.hidden = false;
        } catch (err) {
            statsLoading.hidden = true;
            statsError.hidden = false;
            statsErrorText.textContent = 'Network error while loading statistics.';
        } finally {
            refreshStatsBtn.disabled = false;
        }
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
            loadStats();
        } catch (err) {
            showToast('Network error. Change was not saved.');
        } finally {
            toggle.disabled = false;
        }
    }

    /**
     * Loads all users from the server, reveals panels, and triggers statistics load.
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
            statsPanel.hidden = false;
            renderList();
            loadStats();
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

    // Modal dialog event listeners
    modalCloseBtn.addEventListener('click', closePasswordModal);
    passwordModal.addEventListener('click', (e) => {
        if (e.target === passwordModal) {
            closePasswordModal();
        }
    });
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !passwordModal.hidden) {
            closePasswordModal();
        }
    });
    generatePasswordBtn.addEventListener('click', () => {
        adminNewPassword.value = generateRandomPassword();
        adminNewPassword.focus();
    });
    resetPasswordForm.addEventListener('submit', submitResetPassword);
    removePasswordBtn.addEventListener('click', handleRemovePassword);

    // Pagination navigation button listeners
    prevPageBtn.addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            renderList();
        }
    });

    nextPageBtn.addEventListener('click', () => {
        const term = searchInput.value.trim().toLowerCase();
        const visible = allUsers.filter(u => u.username.toLowerCase().indexOf(term) !== -1);
        const totalPages = Math.ceil(visible.length / PAGE_SIZE);
        if (currentPage < totalPages) {
            currentPage++;
            renderList();
        }
    });

    // Reset pagination to first page upon search filter entry
    searchInput.addEventListener('input', () => {
        currentPage = 1;
        renderList();
    });

    // Statistics manual refresh and error retry handlers
    refreshStatsBtn.addEventListener('click', loadStats);
    retryStatsBtn.addEventListener('click', loadStats);

    init();
})();
