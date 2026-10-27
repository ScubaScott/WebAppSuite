/**
 * ScoreBoard console effects: toast messages, the whistle, the goal and card animations, and sharing text.
 * These touch the DOM and device APIs; every device call fails quietly when unsupported or denied.
 */

let toastTimer = null;

/** Show a brief floating message. */
export function showToast(message) {
    const toast = document.getElementById('clipboard-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

/** Play the period-end whistle unless muted. */
export function playWhistle(muted) {
    const audio = document.getElementById('whistle-sound');
    if (muted || !audio) return;
    try {
        audio.currentTime = 0;
        audio.play().catch(() => { });
    } catch (error) {
        // Audio unavailable: the whistle is skipped
    }
}

/** Create a fixed overlay centered on an element and remove it after `lifetimeMs`. */
function overlayAt(anchor, className, lifetimeMs) {
    const rect = anchor.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.className = className;
    overlay.style.left = `${rect.left + rect.width / 2}px`;
    overlay.style.top = `${rect.top + rect.height / 2}px`;
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), lifetimeMs);
    return overlay;
}

/** Particle-burst celebration anchored to a score box. Runs in a fixed overlay so layout never shifts. */
export function playScoreSplash(anchor, color) {
    if (!anchor) return;
    const overlay = overlayAt(anchor, 'score-splash-overlay', 1100);
    overlay.style.width = '0';
    overlay.style.height = '0';

    const ring = document.createElement('div');
    ring.className = 'score-splash-ring';
    ring.style.cssText = `width:80px;height:80px;left:0;top:0;border:3px solid ${color};opacity:0.8`;
    overlay.appendChild(ring);

    const particleCount = 10;
    for (let i = 0; i < particleCount; i++) {
        const particle = document.createElement('div');
        particle.className = 'score-splash-particle';
        const angle = (360 / particleCount) * i;
        const distance = 55 + Math.random() * 35;
        const size = 7 + Math.random() * 7;
        particle.style.cssText = [
            `width:${size}px`, `height:${size}px`, 'left:0', 'top:0', `background:${color}`,
            `--tx:${Math.cos(angle * Math.PI / 180) * distance}px`,
            `--ty:${Math.sin(angle * Math.PI / 180) * distance}px`,
            `--rot:${Math.random() * 360}deg`,
            `animation-delay:${Math.random() * 0.15}s`,
            `box-shadow:0 0 6px 2px ${color}55`
        ].join(';');
        overlay.appendChild(particle);
    }

    const label = document.createElement('div');
    label.className = 'score-splash-score-label';
    label.textContent = '+1';
    label.style.cssText = `color:${color};left:0;top:0;white-space:nowrap`;
    overlay.appendChild(label);
}

/** Card-raising animation anchored to a team's score box. */
export function playCardRaise(anchor, cardType) {
    if (!anchor) return;
    const overlay = overlayAt(anchor, 'card-raise-overlay', 1050);
    const card = document.createElement('div');
    card.className = `card-raise-card ${cardType}`;

    const icon = document.createElement('div');
    icon.className = 'card-raise-card-icon';
    icon.textContent = cardType === 'yellow' ? '🟨' : '🟥';

    const text = document.createElement('div');
    text.className = 'card-raise-card-text';
    text.textContent = cardType === 'yellow' ? 'Yellow' : 'Red';

    card.appendChild(icon);
    card.appendChild(text);
    overlay.appendChild(card);
}

/** Copy text with the clipboard API, falling back to a hidden textarea. */
function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text)
            .then(() => showToast('✓ Copied to clipboard for SMS'))
            .catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    area.style.top = '0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    try {
        document.execCommand('copy');
        showToast('✓ Copied to clipboard for SMS');
    } catch (error) {
        showToast('Could not copy to clipboard');
    }
    area.remove();
}

/** Copy text to the clipboard and open the device share sheet when available. */
export function shareText(text) {
    copyText(text);
    if (navigator.share) {
        navigator.share({ text }).catch((error) => {
            // The operator dismissing the share sheet is expected
            if (error.name !== 'AbortError') console.warn('Share failed:', error);
        });
    }
}
