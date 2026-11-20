// Suite dialog version identifier
const SUITE_DIALOG_VERSION = '1.0';

// Themed replacements for the browser's alert(), confirm() and prompt(), shared by every WebAppSuite sub-application.
// The browser versions announce "<site name> says..." and cannot be styled; these show exactly the wording the app gives
// them in a box that follows the page's theme (see suite-dialog.css, which must be linked). Each call returns a promise,
// so callers await it:
//
//   await SuiteDialog.alert('The score could not be saved.', { title: 'Score not saved' });
//   if (await SuiteDialog.confirm('All scores in every round are deleted.', { title: 'Remove Anna?', confirmLabel: 'Remove player', danger: true })) { ... }
//   const name = await SuiteDialog.prompt('Name this game:', { title: 'Save game', value: 'Friday night' });   // null if cancelled
//
// Messages and titles are plain text (a "\n" starts a new paragraph); nothing is interpreted as HTML.
const SuiteDialog = (() => {
    let counter = 0;

    // Opens a dialog, falling back to the open attribute where <dialog>.showModal is unsupported
    function open(dialog) {
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
    }

    function closeDialog(dialog) {
        if (typeof dialog.close === 'function' && dialog.open) dialog.close();
        else dialog.removeAttribute('open');
    }

    // Builds one dialog from a spec, shows it, and resolves with the value of the button used (or spec.dismissValue when it
    // is dismissed with Escape or a tap on the dimmed background).
    // spec: { title, message, buttons: [{ label, value(), confirm?, danger? }], defaultIndex, dismissValue, input? }
    function show(spec) {
        return new Promise(resolve => {
            const previousFocus = document.activeElement;
            const id = 'suiteDialog' + (++counter);
            const dialog = document.createElement('dialog');
            dialog.className = 'suite-dialog';
            dialog.setAttribute('role', spec.input ? 'dialog' : 'alertdialog');
            dialog.setAttribute('aria-labelledby', id + 'Title');
            dialog.setAttribute('aria-describedby', id + 'Message');

            const body = document.createElement('div');
            body.className = 'sd-body';
            const title = document.createElement('h2');
            title.className = 'sd-title';
            title.id = id + 'Title';
            title.textContent = spec.title || '';
            if (spec.title) body.appendChild(title);

            const messageBox = document.createElement('div');
            messageBox.id = id + 'Message';
            String(spec.message || '').split('\n').filter(Boolean).forEach(line => {
                const p = document.createElement('p');
                p.className = 'sd-message';
                p.textContent = line;
                messageBox.appendChild(p);
            });
            body.appendChild(messageBox);

            let input = null;
            if (spec.input) {
                input = document.createElement('input');
                input.className = 'sd-input';
                input.type = spec.input.type || 'text';
                input.value = spec.input.value || '';
                if (spec.input.placeholder) input.placeholder = spec.input.placeholder;
                if (spec.input.maxLength) input.maxLength = spec.input.maxLength;
                input.setAttribute('aria-label', spec.title || spec.message || 'Value');
                spec.input.element = input;                    // lets the caller's button read the text when it is pressed
                body.appendChild(input);
            }

            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', onEscapeFallback, true);
                closeDialog(dialog);
                dialog.remove();
                if (previousFocus && typeof previousFocus.focus === 'function') {
                    try { previousFocus.focus(); } catch (err) { /* the element may be gone */ }
                }
                resolve(value);
            };

            const actions = document.createElement('div');
            actions.className = 'sd-actions';
            const buttons = spec.buttons.map(def => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'sd-btn' + (def.confirm ? ' sd-confirm' : ' sd-cancel') + (def.danger ? ' sd-danger' : '');
                button.textContent = def.label;
                button.addEventListener('click', () => finish(def.value()));
                actions.appendChild(button);
                return button;
            });
            body.appendChild(actions);
            dialog.appendChild(body);

            // Escape and a tap on the dimmed background dismiss the dialog
            dialog.addEventListener('cancel', event => { event.preventDefault(); finish(spec.dismissValue); });
            dialog.addEventListener('click', event => { if (event.target === dialog) finish(spec.dismissValue); });
            // Enter in a text box confirms
            if (input) {
                input.addEventListener('keydown', event => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        const confirmDef = spec.buttons.find(b => b.confirm);
                        if (confirmDef) finish(confirmDef.value());
                    }
                });
            }
            // Without <dialog> support there is no cancel event, so Escape is handled here
            function onEscapeFallback(event) {
                if (event.key === 'Escape' && typeof dialog.showModal !== 'function') finish(spec.dismissValue);
            }
            document.addEventListener('keydown', onEscapeFallback, true);

            document.body.appendChild(dialog);
            open(dialog);
            if (input) { input.focus(); input.select(); }
            else (buttons[spec.defaultIndex] || buttons[buttons.length - 1]).focus();
        });
    }

    // Shows a message with one button. Resolves when it is closed.
    // options: { title, okLabel = 'OK' }
    function alert(message, options) {
        const o = options || {};
        return show({
            title: o.title, message,
            buttons: [{ label: o.okLabel || 'OK', value: () => undefined, confirm: true }],
            defaultIndex: 0, dismissValue: undefined
        });
    }

    // Asks a yes/no question. Resolves true for the confirm button, false for cancel, Escape or a tap outside.
    // options: { title, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false (red confirm button),
    //            defaultCancel = false (focus starts on Cancel, so a stray Enter does not confirm) }
    function confirm(message, options) {
        const o = options || {};
        return show({
            title: o.title, message,
            buttons: [
                { label: o.cancelLabel || 'Cancel', value: () => false },
                { label: o.confirmLabel || 'OK', value: () => true, confirm: true, danger: !!o.danger }
            ],
            defaultIndex: o.defaultCancel || o.danger ? 0 : 1, dismissValue: false
        });
    }

    // Asks for a line of text. Resolves with the text, or null when cancelled.
    // options: { title, value, placeholder, maxLength, type = 'text', confirmLabel = 'OK', cancelLabel = 'Cancel' }
    function prompt(message, options) {
        const o = options || {};
        const field = { value: o.value, placeholder: o.placeholder, maxLength: o.maxLength, type: o.type, element: null };
        return show({
            title: o.title, message,
            input: field,
            buttons: [
                { label: o.cancelLabel || 'Cancel', value: () => null },
                { label: o.confirmLabel || 'OK', value: () => (field.element ? field.element.value : ''), confirm: true }
            ],
            defaultIndex: 1, dismissValue: null
        });
    }

    return { VERSION: SUITE_DIALOG_VERSION, alert, confirm, prompt };
})();
