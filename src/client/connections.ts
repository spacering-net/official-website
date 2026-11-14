/** Website-owned connection management; no client credentials are exposed. */
export function initConnections(root: HTMLElement, account: () => number | null, accountChanged: () => Promise<void>) {
  const zh = document.documentElement.lang.startsWith('zh');
  const say = (en: string, cn: string) => zh ? cn : en;
  const details = root.querySelector<HTMLDetailsElement>('[data-connections]')!;
  const list = root.querySelector<HTMLElement>('[data-connections-list]')!;
  const changed = root.querySelector<HTMLElement>('[data-connections-changed]')!;
  let sequence = 0;
  const load = async (cursor?: string) => {
    const asked = ++sequence;
    const owner = account();
    if (!owner || !details.open) return;
    if (!cursor) list.textContent = say('Loading…', '正在加载…');
    try {
      const res = await fetch(`/api/me/clients${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error('load');
      const data = await res.json() as { account_srn: number; next_cursor: string | null; clients: { id: string; client_name: string; client_origin: string | null; device_name: string | null; platform: string; last_used_at: string; status: 'active' | 'expired' | 'revoked' | 'disabled' }[] };
      if (asked !== sequence || account() !== owner || !details.open) return;
      if (data.account_srn !== owner) {
        await accountChanged();
        changed.hidden = false;
        return;
      }
      if (!cursor) list.replaceChildren();
      else list.querySelector('[data-more]')?.remove();
      if (!data.clients.length) list.textContent = say('No connected clients.', '暂无已连接的客户端。');
      for (const item of data.clients) {
        const row = document.createElement('div');
        row.className = 'account__connection';
        const name = document.createElement('p');
        // A Web connection is held by the instance at that origin; device and
        // platform are only what the client said about itself.
        name.textContent = item.client_origin
          ? `${item.client_name} Web · ${item.client_origin}`
          : `${item.client_name} · ${item.device_name ?? item.platform}`;
        const time = document.createElement('small');
        const note = item.status === 'expired' ? say(' · Expired', ' · 已过期') : item.status === 'disabled' ? say(' · Service disabled', ' · 服务已停用') : '';
        time.textContent = `${say('Last used: ', '最近使用：')}${new Date(item.last_used_at).toLocaleString(zh ? 'zh-CN' : 'en')}${note}`;
        const revoke = document.createElement('button');
        revoke.className = 'account__stop';
        revoke.type = 'button';
        // Expired and revoked connections can no longer be used. A disabled
        // service's connections come back if it is enabled again, so they
        // stay revocable.
        const invalid = item.status === 'revoked' || item.status === 'expired';
        revoke.textContent = item.status === 'revoked' ? say('Disconnected', '已断开') : item.status === 'expired' ? say('Expired', '已过期') : say('Revoke connection', '撤销连接');
        revoke.disabled = invalid;
        revoke.addEventListener('click', async () => {
          if (account() !== owner) return;
          revoke.disabled = true;
          const response = await fetch(`/api/me/clients/${encodeURIComponent(item.id)}`, {
            method: 'DELETE', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ expected_srn: owner }),
          }).catch(() => null);
          if (account() !== owner || !details.open) return;
          if (response?.ok) await load();
          else if (response?.status === 409 || response?.status === 401) { await accountChanged(); changed.hidden = false; }
          else { revoke.disabled = false; revoke.textContent = say('Failed; retry revoke', '撤销失败，点击重试'); }
        });
        row.append(name, time, revoke);
        list.append(row);
      }
      if (data.next_cursor) {
        const more = document.createElement('button');
        more.type = 'button'; more.className = 'account__stop'; more.dataset.more = '';
        more.textContent = say('Load more', '加载更多');
        more.addEventListener('click', () => { more.disabled = true; void load(data.next_cursor!); });
        list.append(more);
      }
    } catch {
      if (asked !== sequence || account() !== owner) return;
      list.textContent = say('Unable to load. Close and reopen to retry.', '暂时无法加载，请收起后重新打开。');
    }
  };
  details.addEventListener('toggle', () => { if (details.open) { changed.hidden = true; void load(); } else sequence++; });
  return { reset() { sequence++; details.open = false; list.replaceChildren(); } };
}
