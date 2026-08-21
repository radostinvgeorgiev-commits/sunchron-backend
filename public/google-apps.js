(() => {
  const AVATAR_STORAGE_KEY = 'synchronWorkAvatarV1';
  const DEFAULT_AVATAR = '🤖';
  const AVATARS = Object.freeze(['🤖', '🧠', '✨', '🦊', '🦉', '🚀', '🌿', '🐼']);

  function readAvatar() {
    try {
      const value = globalThis.localStorage?.getItem(AVATAR_STORAGE_KEY);
      return AVATARS.includes(value) ? value : DEFAULT_AVATAR;
    } catch {
      return DEFAULT_AVATAR;
    }
  }

  function initializeAvatarPicker() {
    const trigger = document.getElementById('workPetBtn');
    const pet = document.getElementById('workPet');
    if (!trigger || !pet || document.getElementById('workAvatarPicker')) return;

    let selectedAvatar = readAvatar();
    const picker = document.createElement('section');
    picker.id = 'workAvatarPicker';
    picker.className = 'work-avatar-picker';
    picker.hidden = true;
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', 'Избор на AI аватар');
    document.body.appendChild(picker);

    trigger.setAttribute('aria-controls', picker.id);
    trigger.setAttribute('aria-haspopup', 'dialog');

    function updateTrigger() {
      pet.textContent = selectedAvatar;
      trigger.setAttribute('aria-label', `Избери аватар. Текущ: ${selectedAvatar}`);
    }

    function renderOptions() {
      picker.replaceChildren();
      const heading = document.createElement('p');
      heading.className = 'work-avatar-picker-title';
      heading.textContent = 'Избери аватар';
      const options = document.createElement('div');
      options.className = 'work-avatar-picker-options';

      for (const avatar of AVATARS) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'work-avatar-option';
        option.dataset.workAvatar = avatar;
        option.textContent = avatar;
        option.setAttribute('aria-label', `Избери аватар ${avatar}`);
        option.setAttribute('aria-pressed', String(avatar === selectedAvatar));
        options.appendChild(option);
      }

      picker.append(heading, options);
    }

    function positionPicker() {
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(288, Math.max(240, window.innerWidth - 24));
      const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
      picker.style.width = `${width}px`;
      picker.style.left = `${left}px`;
      picker.style.top = `${Math.min(window.innerHeight - picker.offsetHeight - 12, rect.bottom + 8)}px`;
    }

    function closePicker({ returnFocus = false } = {}) {
      if (picker.hidden) return;
      picker.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (returnFocus) trigger.focus({ preventScroll: true });
    }

    function openPicker() {
      renderOptions();
      picker.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      positionPicker();
      picker.querySelector(`[data-work-avatar='${selectedAvatar}']`)?.focus({ preventScroll: true });
    }

    function togglePicker() {
      if (picker.hidden) openPicker();
      else closePicker();
    }

    function persistAvatar() {
      try {
        globalThis.localStorage?.setItem(AVATAR_STORAGE_KEY, selectedAvatar);
      } catch {
        // The selection remains available for the current page when storage is blocked.
      }
    }

    updateTrigger();
    trigger.setAttribute('aria-expanded', 'false');

    trigger.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        togglePicker();
      },
      true,
    );

    picker.addEventListener('click', (event) => {
      const option = event.target.closest('button[data-work-avatar]');
      if (!option || !AVATARS.includes(option.dataset.workAvatar)) return;
      selectedAvatar = option.dataset.workAvatar;
      updateTrigger();
      persistAvatar();
      closePicker({ returnFocus: true });
    });

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || picker.hidden) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        closePicker({ returnFocus: true });
      },
      true,
    );

    document.addEventListener(
      'pointerdown',
      (event) => {
        if (picker.hidden || picker.contains(event.target) || trigger.contains(event.target)) return;
        closePicker();
      },
      true,
    );

    window.addEventListener('resize', () => {
      if (!picker.hidden) positionPicker();
    });

    globalThis.SynchronAvatarPicker = Object.freeze({
      storageKey: AVATAR_STORAGE_KEY,
      open: openPicker,
      close: closePicker,
    });
  }

  function installAvatarPickerStyles() {
    if (document.getElementById('workAvatarPickerStyles')) return;
    const style = document.createElement('style');
    style.id = 'workAvatarPickerStyles';
    style.textContent = `
      .work-avatar-picker { position: fixed; z-index: 90; padding: 12px; border: 1px solid #d7e0ea; border-radius: 16px; color: #17212b; background: #fff; box-shadow: 0 16px 40px rgba(15, 23, 42, .18); }
      .work-avatar-picker[hidden] { display: none; }
      .work-avatar-picker-title { margin: 0 0 10px; color: #475569; font-size: 13px; font-weight: 750; }
      .work-avatar-picker-options { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
      .work-avatar-option { min-width: 48px; min-height: 48px; border: 1px solid #d7e0ea; border-radius: 12px; background: #fff; cursor: pointer; font-size: 24px; line-height: 1; }
      .work-avatar-option:hover { border-color: #94a3b8; background: #f8fafc; }
      .work-avatar-option[aria-pressed='true'] { border-color: #111; background: #eaf2ff; box-shadow: inset 0 0 0 1px #111; }
      .work-avatar-option:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
    `;
    document.head.appendChild(style);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      installAvatarPickerStyles();
      initializeAvatarPicker();
    }, { once: true });
  } else {
    installAvatarPickerStyles();
    initializeAvatarPicker();
  }

  const drawer = document.getElementById('dataDrawer');
  const backdrop = document.getElementById('drawerBackdrop');
  const title = document.getElementById('dataDrawerTitle');
  const body = document.getElementById('dataDrawerBody');
  const sidebar = document.getElementById('sidebar');
  const gmailButton = document.getElementById('gmailBtn');
  const calendarButton = document.getElementById('googleCalendarBtn');
  const mapsButton = document.getElementById('googleMapsBtn');
  if (!drawer || !body || !gmailButton || !calendarButton || !mapsButton) return;

  const escapeHtml = (value) => {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
  };

  function openDrawer(name) {
    title.textContent = name;
    drawer.hidden = false;
    backdrop.hidden = false;
    sidebar.classList.remove('mobile-visible');
  }

  async function request(path) {
    const response = await fetch(path, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Google услугата временно не е достъпна.');
    return data;
  }

  function reconnect(error) {
    body.innerHTML = `
      <div class='drawer-state drawer-error'>${escapeHtml(error.message)}</div>
      <button type='button' class='new-chat' id='reconnectGoogle'>
        <i class='fa-brands fa-google'></i><span>Свържи Google отново</span>
      </button>`;
    document.getElementById('reconnectGoogle').addEventListener('click', () => {
      window.location.href = '/api/google/connect';
    });
  }

  async function showGmail() {
    openDrawer('Gmail');
    body.innerHTML = '<div class="drawer-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Зареждане…</div>';
    try {
      const data = await request('/api/google/gmail/messages?limit=15');
      const messages = Array.isArray(data.messages) ? data.messages : [];
      body.innerHTML = `
        <section class='drawer-section'>
          <div class='permission-default'>Последни имейли — само за четене. AI CORE не може да изпраща или изтрива.</div>
          ${messages.length ? messages.map((message) => `
            <article class='permission-card'>
              <div>
                <strong>${message.unread ? '● ' : ''}${escapeHtml(message.subject)}</strong>
                <p>${escapeHtml(message.from)}</p>
                <p>${escapeHtml(message.snippet)}</p>
              </div>
              <a href="${escapeHtml(message.url)}" target='_blank' rel='noopener noreferrer'>Отвори</a>
            </article>`).join('') : '<div class="drawer-empty">Няма намерени имейли.</div>'}
        </section>`;
    } catch (error) {
      reconnect(error);
    }
  }

  async function showCalendar() {
    openDrawer('Google Calendar');
    body.innerHTML = '<div class="drawer-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Зареждане…</div>';
    try {
      const data = await request('/api/google/calendar/events?days=14&limit=25');
      const events = Array.isArray(data.events) ? data.events : [];
      body.innerHTML = `
        <section class='drawer-section'>
          <div class='permission-default'>Предстоящи събития за 14 дни — само за четене.</div>
          ${events.length ? events.map((event) => `
            <article class='permission-card'>
              <div>
                <strong>${escapeHtml(event.title)}</strong>
                <p>${event.start ? new Date(event.start).toLocaleString('bg-BG') : ''}</p>
                ${event.location ? `<p>${escapeHtml(event.location)}</p>` : ''}
              </div>
              ${event.url ? `<a href="${escapeHtml(event.url)}" target='_blank' rel='noopener noreferrer'>Отвори</a>` : ''}
            </article>`).join('') : '<div class="drawer-empty">Няма предстоящи събития.</div>'}
        </section>`;
    } catch (error) {
      reconnect(error);
    }
  }

  function showMaps() {
    openDrawer('Google Maps');
    body.innerHTML = `
      <section class='drawer-section'>
        <div class='permission-default'>Потърси място, хотел, заведение или маршрут. Резултатът се отваря в Google Maps.</div>
        <div class='chat-input-area'>
          <input id='mapsQuery' type='search' placeholder='Например: хотел в Търново'>
          <button id='mapsSearch' type='button' aria-label='Търси'><i class='fa-solid fa-magnifying-glass'></i></button>
        </div>
      </section>`;
    const input = document.getElementById('mapsQuery');
    const search = () => {
      const query = input.value.trim();
      if (query) window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`, '_blank', 'noopener,noreferrer');
    };
    document.getElementById('mapsSearch').addEventListener('click', search);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') search();
    });
    input.focus();
  }

  gmailButton.addEventListener('click', showGmail);
  calendarButton.addEventListener('click', showCalendar);
  mapsButton.addEventListener('click', showMaps);
})();
