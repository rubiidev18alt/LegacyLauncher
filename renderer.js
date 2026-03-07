const { ipcRenderer, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const extractZip = require('extract-zip');
const childProcess = require('child_process');

const DEFAULT_REPO = "smartcmd/MinecraftConsoles";
const DEFAULT_EXEC = "Minecraft.Client.exe";
const TARGET_FILE = "LCEWindows64.zip";
const LAUNCHER_REPO = "gradenGnostic/LegacyLauncher";

let releasesData = [];
let commitsData = [];
let currentReleaseIndex = 0;
let isProcessing = false;
let isGameRunning = false;


const Store = {
    async get(key, defaultValue) {
        const val = await ipcRenderer.invoke('store-get', key);
        return val !== undefined ? val : defaultValue;
    },
    async set(key, value) {
        return await ipcRenderer.invoke('store-set', key, value);
    }
};

// Gamepad Controller Support
const GamepadManager = {
    active: false,
    lastInputTime: 0,
    COOLDOWN: 180,
    loopStarted: false,
    lastAPressed: false,

    init() {
        window.addEventListener("gamepadconnected", () => {
            if (!this.active) {
                this.startLoop();
            }
        });
        this.startLoop();
    },

    startLoop() {
        if (this.loopStarted) return;
        this.loopStarted = true;
        const loop = () => {
            try {
                this.poll();
            } catch (e) {
                console.error("Gamepad poll error:", e);
            }
            requestAnimationFrame(loop);
        };
        loop();
    },

    poll() {
        const gamepads = navigator.getGamepads();
        let gp = null;
        for (let i = 0; i < gamepads.length; i++) {
            if (gamepads[i] && gamepads[i].connected && gamepads[i].buttons.length > 0) {
                gp = gamepads[i];
                break;
            }
        }

        if (!gp) {
            if (this.active) {
                this.active = false;
                showToast("Controller Disconnected");
            }
            return;
        }

        if (!this.active) {
            this.active = true;
            showToast("Controller Connected");
            if (!document.activeElement || !document.activeElement.classList.contains('nav-item')) {
                this.focusFirstVisible();
            }
        }

        const now = Date.now();
        const buttons = gp.buttons;
        const axes = gp.axes;

        // Helper to safely get button state
        const isPressed = (idx) => buttons[idx] ? buttons[idx].pressed : false;
        const getAxis = (idx) => axes[idx] !== undefined ? axes[idx] : 0;

        if (now - this.lastInputTime > this.COOLDOWN) {
            const threshold = 0.5;
            const axisX = getAxis(0);
            const axisY = getAxis(1);
            
            // D-pad indices are usually 12, 13, 14, 15
            const up = isPressed(12) || axisY < -threshold;
            const down = isPressed(13) || axisY > threshold;
            const left = isPressed(14) || axisX < -threshold;
            const right = isPressed(15) || axisX > threshold;

            if (up) { this.navigate('up'); this.lastInputTime = now; }
            else if (down) { this.navigate('down'); this.lastInputTime = now; }
            else if (left) { this.navigate('left'); this.lastInputTime = now; }
            else if (right) { this.navigate('right'); this.lastInputTime = now; }
            
            // Shoulder buttons (L1/R1 are 4/5)
            else if (isPressed(4)) { this.cycleActiveSelection(-1); this.lastInputTime = now; }
            else if (isPressed(5)) { this.cycleActiveSelection(1); this.lastInputTime = now; }
            
            // B Button (Cancel)
            else if (isPressed(1)) { this.cancelCurrent(); this.lastInputTime = now; }

            // X Button (Refresh)
            else if (isPressed(2)) { checkForUpdatesManual(); this.lastInputTime = now; }
        }

        // A Button (Confirm) - Immediate responsive check
        const aPressed = isPressed(0);
        if (aPressed && !this.lastAPressed) {
            this.clickActive();
        }
        this.lastAPressed = aPressed;

        // Right stick for scrolling (Axis 2/3 or 5)
        const rStickY = getAxis(3) || getAxis(2) || getAxis(5);
        if (Math.abs(rStickY) > 0.1) {
            this.scrollActive(rStickY * 15);
        }
    },

    focusFirstVisible() {
        const visibleItems = this.getVisibleNavItems();
        if (visibleItems.length > 0) visibleItems[0].focus();
    },

    getVisibleNavItems() {
        // Find if any modal is open
        const modals = ['update-modal', 'options-modal', 'profile-modal', 'servers-modal'];
        let activeModal = null;
        for (const id of modals) {
            const m = document.getElementById(id);
            if (m && m.style.display === 'flex') {
                activeModal = m;
                break;
            }
        }

        const allItems = Array.from(document.querySelectorAll('.nav-item'));
        return allItems.filter(item => {
            if (activeModal) {
                return activeModal.contains(item) && item.offsetParent !== null;
            }
            // Ensure item is not inside any hidden modal
            let parent = item.parentElement;
            while (parent) {
                if (parent.classList?.contains('modal-overlay') && parent.style.display !== 'flex') return false;
                parent = parent.parentElement;
            }
            return item.offsetParent !== null;
        });
    },

    navigate(direction) {
        const current = document.activeElement;
        const items = this.getVisibleNavItems();

        if (!items.includes(current)) {
            items[0]?.focus();
            return;
        }

        const currentRect = current.getBoundingClientRect();
        const cx = currentRect.left + currentRect.width / 2;
        const cy = currentRect.top + currentRect.height / 2;

        let bestMatch = null;
        let minScore = Infinity;

        items.forEach(item => {
            if (item === current) return;
            const rect = item.getBoundingClientRect();
            const ix = rect.left + rect.width / 2;
            const iy = rect.top + rect.height / 2;

            const dx = ix - cx;
            const dy = iy - cy;
            const angle = Math.atan2(dy, dx) * 180 / Math.PI;

            let inDirection = false;
            if (direction === 'right' && angle >= -45 && angle <= 45) inDirection = true;
            if (direction === 'left' && (angle >= 135 || angle <= -135)) inDirection = true;
            if (direction === 'down' && angle > 45 && angle < 135) inDirection = true;
            if (direction === 'up' && angle < -45 && angle > -135) inDirection = true;

            if (inDirection) {
                const distance = Math.sqrt(dx * dx + dy * dy);
                const penalty = (direction === 'left' || direction === 'right') ? Math.abs(dy) * 2.5 : Math.abs(dx) * 2.5;
                const score = distance + penalty;

                if (score < minScore) {
                    minScore = score;
                    bestMatch = item;
                }
            }
        });

        if (bestMatch) {
            bestMatch.focus();
            bestMatch.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    },

    clickActive() {
        const active = document.activeElement;
        if (active && active.classList.contains('nav-item')) {
            active.classList.add('active-bump');
            setTimeout(() => active.classList.remove('active-bump'), 100);
            
            if (active.tagName === 'INPUT' && active.type === 'checkbox') {
                active.checked = !active.checked;
                active.dispatchEvent(new Event('change'));
            } else {
                active.click();
            }
        }
    },

    cancelCurrent() {
        const activeModal = this.getActiveModal();
        if (activeModal) {
            if (activeModal.id === 'options-modal') toggleOptions(false);
            else if (activeModal.id === 'profile-modal') toggleProfile(false);
            else if (activeModal.id === 'servers-modal') toggleServers(false);
            else if (activeModal.id === 'update-modal') document.getElementById('btn-skip-update')?.click();
        }
    },

    getActiveModal() {
        const modals = ['update-modal', 'options-modal', 'profile-modal', 'servers-modal'];
        for (const id of modals) {
            const m = document.getElementById(id);
            if (m && m.style.display === 'flex') return m;
        }
        return null;
    },

    cycleActiveSelection(dir) {
        const active = document.activeElement;
        if (active && active.id === 'version-select-box') {
            const select = document.getElementById('version-select');
            if (select) {
                let newIdx = select.selectedIndex + dir;
                if (newIdx < 0) newIdx = select.options.length - 1;
                if (newIdx >= select.options.length) newIdx = 0;
                select.selectedIndex = newIdx;
                updateSelectedRelease();
            }
        } else if (active && active.id === 'compat-select-box') {
            const select = document.getElementById('compat-select');
            if (select) {
                let newIdx = select.selectedIndex + dir;
                if (newIdx < 0) newIdx = select.options.length - 1;
                if (newIdx >= select.options.length) newIdx = 0;
                select.selectedIndex = newIdx;
                updateCompatDisplay();
            }
        } else if (!this.getActiveModal()) {
            // Shortcut for version cycle on main menu
            const select = document.getElementById('version-select');
            if (select) {
                let newIdx = select.selectedIndex + dir;
                if (newIdx < 0) newIdx = select.options.length - 1;
                if (newIdx >= select.options.length) newIdx = 0;
                select.selectedIndex = newIdx;
                updateSelectedRelease();
            }
        }
    },

    scrollActive(val) {
        const serverList = document.getElementById('servers-list-container');
        if (this.getActiveModal()?.id === 'servers-modal' && serverList) {
            serverList.scrollTop += val;
        } else if (!this.getActiveModal()) {
            const sidebar = document.getElementById('updates-list')?.parentElement;
            if (sidebar) sidebar.scrollTop += val;
        }
    }
};

window.onload = async () => {
    document.getElementById('repo-input').value = await Store.get('legacy_repo', DEFAULT_REPO);
    document.getElementById('exec-input').value = await Store.get('legacy_exec_path', DEFAULT_EXEC);
    document.getElementById('username-input').value = await Store.get('legacy_username', "");
    document.getElementById('ip-input').value = await Store.get('legacy_ip', "");
    document.getElementById('port-input').value = await Store.get('legacy_port', "");
    document.getElementById('server-checkbox').checked = await Store.get('legacy_is_server', false);
    
    if (process.platform === 'linux' || process.platform === 'darwin') {
        document.getElementById('compat-option-container').style.display = 'block';
        scanCompatibilityLayers();
    } else {
        // Force Windows to direct mode if somehow changed
        await Store.set('legacy_compat_layer', 'direct');
    }

    ipcRenderer.on('window-is-maximized', (event, isMaximized) => {
        document.getElementById('maximize-btn').textContent = isMaximized ? '❐' : '▢';
    });

    fetchGitHubData();
    checkForLauncherUpdates();
    GamepadManager.init();
};

async function checkForLauncherUpdates() {
    try {
        const currentVersion = require('./package.json').version;
        const res = await fetch(`https://api.github.com/repos/${LAUNCHER_REPO}/releases/latest`);
        if (!res.ok) return;
        
        const latestRelease = await res.json();
        const latestVersion = latestRelease.tag_name.replace('v', '');
        
        if (latestVersion !== currentVersion) {
            const updateConfirmed = await promptLauncherUpdate(latestRelease.tag_name);
            if (updateConfirmed) {
                downloadAndInstallLauncherUpdate(latestRelease);
            }
        }
    } catch (e) {
        console.error("Launcher update check failed:", e);
    }
}

async function promptLauncherUpdate(version) {
    return new Promise((resolve) => {
        const modal = document.getElementById('update-modal');
        const confirmBtn = document.getElementById('btn-confirm-update');
        const skipBtn = document.getElementById('btn-skip-update');
        const closeBtn = document.getElementById('btn-close-update');

        document.getElementById('update-modal-text').innerHTML = 
            `A new Launcher version <b>${version}</b> is available.<br><br>` +
            `Would you like to download and install it now?`;

        modal.style.display = 'flex';
        modal.style.opacity = '1';

        const cleanup = (result) => {
            modal.style.opacity = '0';
            setTimeout(() => modal.style.display = 'none', 300);
            confirmBtn.onclick = null;
            skipBtn.onclick = null;
            closeBtn.onclick = null;
            resolve(result);
        };

        confirmBtn.onclick = () => cleanup(true);
        skipBtn.onclick = () => cleanup(false);
        closeBtn.onclick = () => cleanup(false);
    });
}

async function downloadAndInstallLauncherUpdate(release) {
    setProcessingState(true);
    updateProgress(0, "Preparing Launcher Update...");

    let assetPattern = "";
    if (process.platform === 'win32') assetPattern = ".exe";
    else if (process.platform === 'linux') assetPattern = ".AppImage";
    else if (process.platform === 'darwin') assetPattern = ".dmg";

    const asset = release.assets.find(a => a.name.toLowerCase().endsWith(assetPattern));
    
    if (!asset) {
        showToast("No compatible update found for your OS.");
        setProcessingState(false);
        return;
    }

    try {
        const homeDir = require('os').homedir();
        const downloadPath = path.join(homeDir, 'Downloads', asset.name);
        
        updateProgress(10, `Downloading Launcher Update...`);
        await downloadFile(asset.browser_download_url, downloadPath);
        
        updateProgress(100, "Download Complete. Launching Installer...");
        
        // Give time for UI update
        await new Promise(r => setTimeout(r, 1000));

        if (process.platform === 'win32') {
            childProcess.exec(`start "" "${downloadPath}"`);
        } else if (process.platform === 'linux') {
            fs.chmodSync(downloadPath, 0o755);
            childProcess.exec(`"${downloadPath}"`);
        } else if (process.platform === 'darwin') {
            childProcess.exec(`open "${downloadPath}"`);
        }
        
        // Close the app to allow installation
        setTimeout(() => ipcRenderer.send('window-close'), 2000);

    } catch (e) {
        showToast("Launcher Update Error: " + e.message);
        setProcessingState(false);
    }
}

async function scanCompatibilityLayers() {
    const select = document.getElementById('compat-select');
    const savedValue = await Store.get('legacy_compat_layer', 'direct');
    
    const layers = [
        { name: 'Default (Direct)', cmd: 'direct' },
        { name: 'Wine64', cmd: 'wine64' },
        { name: 'Wine', cmd: 'wine' }
    ];

    const homeDir = require('os').homedir();
    let steamPaths = [];
    
    if (process.platform === 'linux') {
        steamPaths = [
            path.join(homeDir, '.steam', 'steam', 'steamapps', 'common'),
            path.join(homeDir, '.local', 'share', 'Steam', 'steamapps', 'common'),
            path.join(homeDir, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam', 'steamapps', 'common')
        ];
    } else if (process.platform === 'darwin') {
        steamPaths = [
            path.join(homeDir, 'Library', 'Application Support', 'Steam', 'steamapps', 'common')
        ];
    }

    for (const steamPath of steamPaths) {
        if (fs.existsSync(steamPath)) {
            try {
                const dirs = fs.readdirSync(steamPath);
                dirs.filter(d => d.startsWith('Proton') || d.includes('Wine') || d.includes('CrossOver')).forEach(d => {
                    // Check for common Proton structure
                    const protonPath = path.join(steamPath, d, 'proton');
                    if (fs.existsSync(protonPath)) {
                        layers.push({ name: d, cmd: protonPath });
                    }
                });
            } catch (e) {}
        }
    }

    select.innerHTML = '';
    layers.forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.cmd;
        opt.textContent = l.name;
        select.appendChild(opt);
        if (l.cmd === savedValue) opt.selected = true;
    });

    updateCompatDisplay();
}

function updateCompatDisplay() {
    const select = document.getElementById('compat-select');
    const display = document.getElementById('current-compat-display');
    if (select && display && select.selectedIndex !== -1) {
        display.textContent = select.options[select.selectedIndex].text;
    }
}

async function getInstalledPath() {
    const homeDir = require('os').homedir();
    const execPath = await Store.get('legacy_exec_path', DEFAULT_EXEC);
    return path.join(homeDir, 'Documents', 'LegacyClient', execPath);
}

async function checkIsInstalled(tag) {
    const fullPath = await getInstalledPath();
    const installedTag = await Store.get('installed_version_tag');
    return fs.existsSync(fullPath) && installedTag === tag;
}

async function updatePlayButtonText() {
    const btn = document.getElementById('btn-play-main');
    if (isProcessing) return;

    if (isGameRunning) {
        btn.textContent = "GAME RUNNING";
        btn.classList.add('running');
        return;
    } else {
        btn.classList.remove('running');
    }

    const release = releasesData[currentReleaseIndex];
    if (!release) {
        btn.textContent = "PLAY";
        return;
    }

    if (await checkIsInstalled(release.tag_name)) {
        btn.textContent = "PLAY";
    } else {
        const fullPath = await getInstalledPath();
        if (fs.existsSync(fullPath)) {
            btn.textContent = "UPDATE";
        } else {
            btn.textContent = "INSTALL";
        }
    }
}

function setGameRunning(running) {
    isGameRunning = running;
    updatePlayButtonText();
}

async function monitorProcess(proc) {
    if (!proc) return;
    const sessionStart = Date.now();
    setGameRunning(true);

    proc.on('exit', async () => {
        const sessionDuration = Math.floor((Date.now() - sessionStart) / 1000);
        const playtime = await Store.get('legacy_playtime', 0);
        await Store.set('legacy_playtime', playtime + sessionDuration);
        setGameRunning(false);
    });
    proc.on('error', (err) => {
        console.error("Process error:", err);
        setGameRunning(false);
    });
}

function minimizeWindow() {
    ipcRenderer.send('window-minimize');
}

function toggleMaximize() {
    ipcRenderer.send('window-maximize');
}

function closeWindow() {
    ipcRenderer.send('window-close');
}

async function fetchGitHubData() {
    const repo = await Store.get('legacy_repo', DEFAULT_REPO);
    const loader = document.getElementById('loader');
    const loaderText = document.getElementById('loader-text');
    loader.style.display = 'flex';
    loaderText.textContent = "SYNCING: " + repo;

    try {
        const [relRes, commRes] = await Promise.all([
            fetch(`https://api.github.com/repos/${repo}/releases`),
            fetch(`https://api.github.com/repos/${repo}/commits`)
        ]);

        if (!relRes.ok || !commRes.ok) throw new Error("Rate Limited or API Error");

        releasesData = await relRes.json();
        commitsData = await commRes.json();

        populateVersions();
        populateUpdatesSidebar();

        setTimeout(() => {
            loader.style.opacity = '0';
            setTimeout(() => loader.style.display = 'none', 300);
        }, 500);
    } catch (err) {
        loaderText.textContent = "REPO NOT FOUND OR API ERROR";
        showToast("Check repository name in Options.");
        setTimeout(() => {
            loader.style.opacity = '0';
            setTimeout(() => loader.style.display = 'none', 300);
        }, 2500);
    }
}

function populateVersions() {
    const select = document.getElementById('version-select');
    const display = document.getElementById('current-version-display');
    select.innerHTML = '';

    if(releasesData.length === 0) {
        display.textContent = "No Releases Found";
        return;
    }

    releasesData.forEach((rel, index) => {
        const opt = document.createElement('option');
        opt.value = index;
        opt.textContent = `Legacy (${rel.tag_name})`;
        select.appendChild(opt);
        if(index === 0) display.textContent = opt.textContent;
    });
    currentReleaseIndex = 0;
    updatePlayButtonText();
}

function populateUpdatesSidebar() {
    const list = document.getElementById('updates-list');
    list.innerHTML = '';

    if (commitsData.length === 0) {
        list.innerHTML = '<div class="update-item">No recent activity found.</div>';
        return;
    }

    // Show the last 20 commits
    commitsData.slice(0, 20).forEach((c) => {
        const item = document.createElement('div');
        item.className = 'update-item patch-note-card commit-card';

        const date = new Date(c.commit.author.date).toLocaleString();
        const shortSha = c.sha.substring(0, 7);
        const message = c.commit.message;

        item.innerHTML = `
            <div class="pn-header">
                <span class="update-date">${date}</span>
                <span class="commit-sha">#${shortSha}</span>
            </div>
            <div class="pn-body commit-msg">${message}</div>
        `;
        list.appendChild(item);
    });
}

function updateSelectedRelease() {
    const select = document.getElementById('version-select');
    currentReleaseIndex = select.value;
    document.getElementById('current-version-display').textContent = select.options[select.selectedIndex].text;
    updatePlayButtonText();
}

async function launchGame() {
    if (isProcessing || isGameRunning) return;

    const release = releasesData[currentReleaseIndex];
    if (!release) return;

    const asset = release.assets.find(a => a.name === TARGET_FILE);
    if (!asset) {
        showToast("ZIP Asset missing in this version!");
        return;
    }

    const isInstalled = await checkIsInstalled(release.tag_name);
    if (isInstalled) {
        setProcessingState(true);
        updateProgress(100, "Launching...");
        await launchLocalClient();
        setProcessingState(false);
    } else {
        const fullPath = await getInstalledPath();
        if (fs.existsSync(fullPath)) {
            const choice = await promptUpdate(release.tag_name);
            if (choice === 'update') {
                setProcessingState(true);
                await handleElectronFlow(asset.browser_download_url);
                setProcessingState(false);
            } else if (choice === 'launch') {
                setProcessingState(true);
                updateProgress(100, "Launching Existing...");
                await launchLocalClient();
                setProcessingState(false);
            }
            // if 'cancel', do nothing
        } else {
            setProcessingState(true);
            await handleElectronFlow(asset.browser_download_url);
            setProcessingState(false);
        }
    }

    updatePlayButtonText();
}

async function promptUpdate(newTag) {
    return new Promise(async (resolve) => {
        const modal = document.getElementById('update-modal');
        const confirmBtn = document.getElementById('btn-confirm-update');
        const skipBtn = document.getElementById('btn-skip-update');
        const closeBtn = document.getElementById('btn-close-update');
        const installedTag = await Store.get('installed_version_tag', "Unknown");

        document.getElementById('update-modal-text').innerHTML = 
            `New version <b>${newTag}</b> is available.<br><br>` +
            `Currently installed: <b>${installedTag}</b>.<br><br>` +
            `Would you like to update now?`;

        modal.style.display = 'flex';
        modal.style.opacity = '1';

        const cleanup = (result) => {
            modal.style.opacity = '0';
            setTimeout(() => modal.style.display = 'none', 300);
            confirmBtn.onclick = null;
            skipBtn.onclick = null;
            closeBtn.onclick = null;
            resolve(result);
        };

        confirmBtn.onclick = () => cleanup('update');
        skipBtn.onclick = () => cleanup('launch');
        closeBtn.onclick = () => cleanup('cancel');
    });
}

// Manual trigger for checking updates via UI button
async function checkForUpdatesManual() {
    // If we have releases data loaded, allow reinstall/update flow regardless of current tag
    const rel = releasesData[currentReleaseIndex];
    if (!rel) {
        showToast("No releases loaded yet");
        return;
    }

    const asset = rel.assets.find(a => a.name === TARGET_FILE);
    if (!asset) {
        showToast("ZIP Asset missing in this version!");
        return;
    }

    const installedTag = await Store.get('installed_version_tag', 'Unknown');
    // Prompt user to update/install; Update path will reinstall (delete existing LegacyClient)
    const choice = await promptUpdate(rel.tag_name);
    if (choice === 'update') {
        // Re-download and install (and launch, as install flow does)
        // handleElectronFlow now manages clean installation while preserving user data
        setProcessingState(true);
        await handleElectronFlow(asset.browser_download_url);
        setProcessingState(false);
    } else if (choice === 'launch') {
        // User chose to launch existing/older version
        setProcessingState(true);
        updateProgress(100, "Launching Existing...");
        await launchLocalClient();
        setProcessingState(false);
    }
    // if 'cancel', do nothing
    updatePlayButtonText();
}

async function launchLocalClient() {
    const fullPath = await getInstalledPath();
    
    if (!fs.existsSync(fullPath)) {
        throw new Error("Executable not found! Try reinstalling.");
    }

    // Ensure the file is executable on Linux/macOS
    if (process.platform !== 'win32') {
        try {
            fs.chmodSync(fullPath, 0o755);
        } catch (e) {
            console.warn("Failed to set executable permissions:", e);
        }
    }

    return new Promise(async (resolve, reject) => {
        const compat = await Store.get('legacy_compat_layer', 'direct');
        const username = await Store.get('legacy_username', "");
        const ip = await Store.get('legacy_ip', "");
        const port = await Store.get('legacy_port', "");
        const isServer = await Store.get('legacy_is_server', false);

        let args = [];
        if (username) args.push("-name", username);
        if (isServer) args.push("-server");
        if (ip) args.push("-ip", ip);
        if (port) args.push("-port", port);

        const argString = args.map(a => `"${a}"`).join(" ");
        let cmd = `"${fullPath}" ${argString}`;
        
        if (process.platform === 'linux' || process.platform === 'darwin') {
            if (compat === 'wine64' || compat === 'wine') {
                cmd = `${compat} "${fullPath}" ${argString}`;
            } else if (compat.includes('Proton')) {
                const prefix = path.join(path.dirname(fullPath), 'pfx');
                if (!fs.existsSync(prefix)) fs.mkdirSync(prefix, { recursive: true });
                
                cmd = `STEAM_COMPAT_CLIENT_INSTALL_PATH="" STEAM_COMPAT_DATA_PATH="${prefix}" "${compat}" run "${fullPath}" ${argString}`;
            }
        }

        console.log("Launching command:", cmd);
        const startTime = Date.now();
        const proc = childProcess.exec(cmd, (error) => {
            const duration = Date.now() - startTime;
            if (error && duration < 2000) {
                showToast("Failed to launch: " + error.message);
                reject(error);
            } else {
                resolve();
            }
        });
        
        monitorProcess(proc);
    });
}

function setProcessingState(active) {
    isProcessing = active;
    const playBtn = document.getElementById('btn-play-main');
    const optionsBtn = document.getElementById('btn-options');
    const progressContainer = document.getElementById('progress-container');

    if (active) {
        playBtn.classList.add('disabled');
        optionsBtn.classList.add('disabled');
        progressContainer.style.display = 'flex';
        updateProgress(0, "Preparing...");
    } else {
        playBtn.classList.remove('disabled');
        optionsBtn.classList.remove('disabled');
        progressContainer.style.display = 'none';
    }
}

function updateProgress(percent, text) {
    document.getElementById('progress-bar-fill').style.width = percent + "%";
    if (text) document.getElementById('progress-text').textContent = text;
}

async function handleElectronFlow(url) {
    try {
        const homeDir = require('os').homedir();
        const docDir = path.join(homeDir, 'Documents');
        const zipPath = path.join(docDir, TARGET_FILE);
        const extractDir = path.join(docDir, 'LegacyClient');
        const backupDir = path.join(docDir, 'LegacyClient_Backup');

        updateProgress(5, "Downloading " + TARGET_FILE + "...");
        await downloadFile(url, zipPath);

        updateProgress(75, "Extracting Archive...");

        // Files to preserve when updating
        const preserveList = [
            'options.txt',
            'servers.txt',
            'username.txt',
            'settings.dat',
            'UID.dat',
            path.join('Windows64', 'GameHDD')
        ];

        if (fs.existsSync(extractDir)) {
            // Backup preserved files
            if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
            fs.mkdirSync(backupDir, { recursive: true });
            
            for (const item of preserveList) {
                const src = path.join(extractDir, item);
                const dest = path.join(backupDir, item);
                if (fs.existsSync(src)) {
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    fs.renameSync(src, dest);
                }
            }
            // Clean install: remove old client files
            try {
                fs.rmSync(extractDir, { recursive: true, force: true });
            } catch (e) {
                console.warn("Cleanup error:", e);
            }
        }

        if (!fs.existsSync(extractDir)) {
            fs.mkdirSync(extractDir, { recursive: true });
        }
        
        await extractZip(zipPath, { dir: extractDir });

        // Restore preserved files
        if (fs.existsSync(backupDir)) {
            for (const item of preserveList) {
                const src = path.join(backupDir, item);
                const dest = path.join(extractDir, item);
                if (fs.existsSync(src)) {
                    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    fs.renameSync(src, dest);
                }
            }
            fs.rmSync(backupDir, { recursive: true, force: true });
        }

        const execName = await Store.get('legacy_exec_path', DEFAULT_EXEC);
        const fullPath = path.join(extractDir, execName);

        if (!fs.existsSync(fullPath)) {
            showToast("Executable not found at: " + execName);
            return;
        }

        updateProgress(100, "Launching...");
        
        await Store.set('installed_version_tag', releasesData[currentReleaseIndex].tag_name);
        
        await new Promise(r => setTimeout(r, 800));
        await launchLocalClient();

    } catch (e) {
        showToast("Error: " + e.message);
    }
}

function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const dir = path.dirname(destPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Always re-download by removing any existing file first
        if (fs.existsSync(destPath)) {
            try { fs.unlinkSync(destPath); } catch (e) { /* ignore */ }
        }

        const file = fs.createWriteStream(destPath);
        let totalSize = 0;
        let downloadedSize = 0;

        https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
                return;
            }

            totalSize = parseInt(response.headers['content-length'], 10);

            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                const percent = Math.floor((downloadedSize / totalSize) * 70) + 5;
                updateProgress(percent, `Downloading... ${percent}%`);
            });

            response.pipe(file);

            file.on('finish', () => {
                file.close(() => resolve());
            });

            file.on('error', (err) => {
                fs.unlink(destPath, () => {});
                reject(err);
            });
        }).on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

function toggleOptions(show) {
    if (isProcessing) return;
    const modal = document.getElementById('options-modal');
    if (show) {
        document.activeElement?.blur();
        modal.style.display = 'flex';
        modal.style.opacity = '1';
    } else {
        modal.style.opacity = '0';
        setTimeout(() => modal.style.display = 'none', 300);
    }
}

async function toggleProfile(show) {
    if (isProcessing) return;
    const modal = document.getElementById('profile-modal');
    if (show) {
        await updatePlaytimeDisplay();
        document.activeElement?.blur();
        modal.style.display = 'flex';
        modal.style.opacity = '1';
    } else {
        modal.style.opacity = '0';
        setTimeout(() => modal.style.display = 'none', 300);
    }
}

async function toggleServers(show) {
    if (isProcessing) return;
    const modal = document.getElementById('servers-modal');
    if (show) {
        await loadServers();
        document.activeElement?.blur();
        modal.style.display = 'flex';
        modal.style.opacity = '1';
    } else {
        modal.style.opacity = '0';
        setTimeout(() => modal.style.display = 'none', 300);
    }
}

async function getServersFilePath() {
    const fullPath = await getInstalledPath();
    return path.join(path.dirname(fullPath), 'servers.txt');
}

async function loadServers() {
    const filePath = await getServersFilePath();
    const container = document.getElementById('servers-list-container');
    container.innerHTML = '';

    if (!fs.existsSync(filePath)) {
        container.innerHTML = '<div class="text-center text-gray-400 py-4">No servers added yet.</div>';
        return;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').map(l => l.trim()).filter(l => l !== '');
        const servers = [];

        for (let i = 0; i < lines.length; i += 3) {
            if (lines[i] && lines[i+1] && lines[i+2]) {
                servers.push({
                    ip: lines[i],
                    port: lines[i+1],
                    name: lines[i+2]
                });
            }
        }

        if (servers.length === 0) {
            container.innerHTML = '<div class="text-center text-gray-400 py-4">No servers added yet.</div>';
            return;
        }

        servers.forEach((s, index) => {
            const item = document.createElement('div');
            item.className = 'flex justify-between items-center p-3 border-b border-[#333] hover:bg-[#111]';
            item.innerHTML = `
                <div class="flex flex-col">
                    <span class="text-white text-xl">${s.name}</span>
                    <span class="text-gray-400 text-sm">${s.ip}:${s.port}</span>
                </div>
                <div class="btn-mc !w-[100px] !h-[40px] !text-lg !mb-0" onclick="removeServer(${index})">DELETE</div>
            `;
            container.appendChild(item);
        });
    } catch (e) {
        console.error("Failed to load servers:", e);
        container.innerHTML = '<div class="text-center text-red-400 py-4">Error loading servers.</div>';
    }
}

async function addServer() {
    const nameInput = document.getElementById('server-name-input');
    const ipInput = document.getElementById('server-ip-input');
    const portInput = document.getElementById('server-port-input');

    const name = nameInput.value.trim();
    const ip = ipInput.value.trim();
    const port = portInput.value.trim() || "25565";

    if (!name || !ip) {
        showToast("Name and IP are required!");
        return;
    }

    const filePath = await getServersFilePath();
    const serverEntry = `${ip}\n${port}\n${name}\n`;

    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        fs.appendFileSync(filePath, serverEntry);
        
        nameInput.value = '';
        ipInput.value = '';
        portInput.value = '';
        
        showToast("Server Added!");
        loadServers();
    } catch (e) {
        showToast("Failed to save server: " + e.message);
    }
}

async function removeServer(index) {
    const filePath = await getServersFilePath();
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').map(l => l.trim()).filter(l => l !== '');
        const servers = [];

        for (let i = 0; i < lines.length; i += 3) {
            if (lines[i] && lines[i+1] && lines[i+2]) {
                servers.push({
                    ip: lines[i],
                    port: lines[i+1],
                    name: lines[i+2]
                });
            }
        }

        servers.splice(index, 1);

        let newContent = "";
        servers.forEach(s => {
            newContent += `${s.ip}\n${s.port}\n${s.name}\n`;
        });

        fs.writeFileSync(filePath, newContent);
        loadServers();
        showToast("Server Removed");
    } catch (e) {
        showToast("Failed to remove server: " + e.message);
    }
}

async function updatePlaytimeDisplay() {
    const el = document.getElementById('playtime-display');
    const playtime = await Store.get('legacy_playtime', 0);
    if (el) el.textContent = formatPlaytime(playtime);
}

function formatPlaytime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
}

async function saveOptions() {
    const newRepo = document.getElementById('repo-input').value.trim();
    const newExec = document.getElementById('exec-input').value.trim();
    const compatSelect = document.getElementById('compat-select');
    const ip = document.getElementById('ip-input').value.trim();
    const port = document.getElementById('port-input').value.trim();
    const isServer = document.getElementById('server-checkbox').checked;

    if (newRepo) await Store.set('legacy_repo', newRepo);
    if (newExec) await Store.set('legacy_exec_path', newExec);
    await Store.set('legacy_ip', ip);
    await Store.set('legacy_port', port);
    await Store.set('legacy_is_server', isServer);
    
    if (compatSelect) {
        await Store.set('legacy_compat_layer', compatSelect.value);
    }

    toggleOptions(false);
    fetchGitHubData();
    updatePlayButtonText();
    showToast("Settings Saved");
}

async function saveProfile() {
    const username = document.getElementById('username-input').value.trim();
    await Store.set('legacy_username', username);
    toggleProfile(false);
    showToast("Profile Updated");
}

function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.display = 'block';
    t.style.animation = 'none';
    t.offsetHeight; 
    t.style.animation = 'slideUp 0.3s ease-out';
    setTimeout(() => { 
        t.style.display = 'none';
    }, 3000);
}

// Global functions for HTML onclick
window.minimizeWindow = minimizeWindow;
window.toggleMaximize = toggleMaximize;
window.closeWindow = closeWindow;
window.launchGame = launchGame;
window.updateSelectedRelease = updateSelectedRelease;
window.toggleProfile = toggleProfile;
window.toggleServers = toggleServers;
window.addServer = addServer;
window.removeServer = removeServer;
window.toggleOptions = toggleOptions;
window.saveOptions = saveOptions;
window.saveProfile = saveProfile;
window.updateCompatDisplay = updateCompatDisplay;
window.checkForUpdatesManual = checkForUpdatesManual;
