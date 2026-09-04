import { describe, expect, it } from 'vitest';
import { parseBuyBackPage } from '../rsi/buyback.js';

function card(opts: {
  title: string;
  image?: string;
  reclaimId?: string;
  ccuPledgeId?: string;
  ccu?: boolean;
}): string {
  const btn = opts.reclaimId
    ? `<a class="holosmallbtn" href="/pledge/buyback/${opts.reclaimId}">Reclaim</a>`
    : opts.ccu
      ? `<a class="holosmallbtn js-open-ship-upgrades"${
          opts.ccuPledgeId ? ` data-pledgeId="${opts.ccuPledgeId}"` : ''
        } href="#">Upgrade</a>`
      : '';
  return `<article class="pledge">
    <h1>${opts.title}</h1>
    <figure><img src="${opts.image ?? '/media/x.jpg'}"></figure>
    <dl><dt>Last Modified</dt><dd>2026-01-01</dd></dl>
    ${btn}
  </article>`;
}

const page = (cards: string[]) => `<html><body>${cards.join('')}</body></html>`;

describe('parseBuyBackPage', () => {
  it('reads the CCU pledge id from data-pledgeId', () => {
    const { pledges } = parseBuyBackPage(
      page([card({ title: 'Aurora MR', ccu: true, ccuPledgeId: '98765' })]),
      1,
    );
    expect(pledges[0]).toMatchObject({ id: '98765', ccuOnly: true, reclaimUrl: null });
  });

  it('assigns unique ids to identical CCU-only pledges', () => {
    const { pledges } = parseBuyBackPage(
      page([
        card({ title: 'Aurora MR', ccu: true }),
        card({ title: 'Aurora MR', ccu: true }),
        card({ title: 'Aurora MR', ccu: true }),
      ]),
      1,
    );
    const ids = pledges.map((p) => p.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toMatch(/^fb:/);
    expect(ids[1]).toBe(`${ids[0]}#2`);
    expect(ids[2]).toBe(`${ids[0]}#3`);
  });

  it('assigns unique ids when RSI repeats data-pledgeId across CCU rows', () => {
    const { pledges } = parseBuyBackPage(
      page([
        card({ title: 'Aurora MR', ccu: true, ccuPledgeId: '4242' }),
        card({ title: 'Aurora LN', ccu: true, ccuPledgeId: '4242' }),
      ]),
      1,
    );
    expect(pledges.map((p) => p.id)).toEqual(['4242', '4242#2']);
  });

  it('keeps distinct pledges distinct and leaves single ids unsuffixed', () => {
    const { pledges } = parseBuyBackPage(
      page([
        card({ title: 'Aurora MR', reclaimId: '111' }),
        card({ title: 'Avenger Titan', reclaimId: '222' }),
      ]),
      1,
    );
    expect(pledges.map((p) => p.id)).toEqual(['111', '222']);
  });

  it('detects the next-page pager', () => {
    const html = `<html><body>${card({ title: 'X', reclaimId: '1' })}<div class="pager"><a class="raquo btn" href="?page=2">»</a></div></body></html>`;
    expect(parseBuyBackPage(html, 1).hasNextPage).toBe(true);
    expect(parseBuyBackPage(page([card({ title: 'X', reclaimId: '1' })]), 1).hasNextPage).toBe(false);
  });
});
