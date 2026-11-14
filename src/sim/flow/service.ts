/**
 * サービス 1 つぶんの流れ。入口(LB か web)から web → cache → db / レプリカ、検索、画像・動画の配信、投稿の加工と保存まで、
 * 台帳に負荷を積む。返す evaluate() は、全サービスの負荷が積み終わったあとに成功率と応答時間を求める。
 */
import { DB_SPLIT, NET, REPLICATION, WORK } from '../config';
import { ROLE_IDS, roleKey, splitRole } from '../types';
import type { RoleId, RoleKey } from '../types';
import type { FlowInput, ServiceLoad } from './types';
import type { Ledger } from './ledger';
import { GB_PER_KB, avg } from './math';

export type ServicePlan = ReturnType<typeof planService>;

export function planService(ledger: Ledger, input: FlowInput, svc: ServiceLoad) {
  const {
    nodeList,
    nodes,
    name,
    loads,
    handoffs,
    isActive,
    path,
    send,
    linesTo,
    fromNet,
    fromNetAlong,
    addCpu,
    addWork,
    addGpuWork,
    hasGpu,
    addIo,
    missOf,
    activeLbs,
    deadLbs,
    lbMs,
    along,
    nodePass,
    cpuMs,
    ioMs,
    transferMs,
  } = ledger;
  const W = svc.work;
  const key = (r: RoleId) => roleKey(svc.id, r);
  const sp: string[] = [];
  const inst = Object.fromEntries(ROLE_IDS.map((r) => [r, [] as number[]])) as Record<RoleId, number[]>;
  for (const n of nodeList) {
    for (const k of n.roles) {
      const [s, r] = splitRole(k);
      if (s === svc.id && isActive(k)) inst[r].push(n.id);
    }
  }
  // ---- db(プライマリ)の分け方
  //  1 台: 読み書きすべて / 機能分割: 1 台目が主なデータ(読み込みの多く)、2 台目が書き込みの多いデータ(コメント・注文など)
  //  シャーディング: 読み書きとデータを台数で等分
  const split = input.dbSplit ?? 'none';
  const maxDb = split === 'shard' ? Infinity : split === 'functional' ? 2 : 1;
  if (inst.db.length > maxDb) {
    sp.push(
      split === 'functional'
        ? `機能分割で使う db は 2 台までです(${name(inst.db[0])} と ${name(inst.db[1])})。もっと分けるならシャーディング`
        : `db(プライマリ)は 1 台だけ使われます(${name(inst.db[0])})。読み込みを分けるならレプリカ、書き込みを分けるなら機能分割かシャーディング`,
    );
    inst.db = inst.db.slice(0, maxDb);
  }
  const shards: { primary: number; read: number; write: number; data: number; replicas: number[] }[] =
    inst.db.length === 2 && split === 'functional'
      ? [
          { primary: inst.db[0], read: 1 - DB_SPLIT.functionalReadShare, write: 0, data: 1 - DB_SPLIT.functionalReadShare, replicas: [] },
          { primary: inst.db[1], read: DB_SPLIT.functionalReadShare, write: 1, data: DB_SPLIT.functionalReadShare, replicas: [] },
        ]
      : inst.db.map((id) => ({ primary: id, read: 1 / inst.db.length, write: 1 / inst.db.length, data: 1 / inst.db.length, replicas: [] }));
  // LB: アプライアンス(HA ペアならアクティブの 1 台)と、SLB の役割を付けたノード。
  // すべて止まっている LB(ペアの両方が止まっているなど)にも DNS でリクエストが来て、その分は失敗する
  const lbNodes = [...activeLbs, ...inst.lb];
  const useLb = lbNodes.length + deadLbs > 0;
  const lbShare = useLb ? lbNodes.length / (lbNodes.length + deadLbs) : 1;
  // LB がなければ、BGP で広報している Pod(MetalLB)がそれぞれ受ける。それもなければ web 1 台だけ
  const advertised = inst.web.filter((n) => nodes.get(n)!.advertised);
  const entries = useLb ? lbNodes : advertised.length ? advertised : inst.web.slice(0, 1);
  if (!useLb && inst.web.length > entries.length) {
    sp.push(
      advertised.length
        ? 'LB がないので、インターネットから届くのは BGP で広報している web の Pod だけです'
        : `LB がないので、インターネットから届くのは ${name(inst.web[0])} だけです(web を並べるには LB か、BGP で広報する Pod が要る)`,
    );
  }
  if (!inst.web.length) sp.push('役割「web」のサーバがありません');
  if (!inst.db.length) sp.push('役割「db」のサーバがありません(db がないとページを表示できない)');
  const webs = useLb ? inst.web : entries;
  /** 検索の肩代わりなどに使う、最初の db */
  const primary: number | undefined = inst.db[0];
  const caches = inst.cache;
  const pv = svc.pv;
  const lbKey = key('lb');

  // media・worker がなければ web が肩代わりする
  const ownMedia = inst.media.length > 0;
  const media = W.media || W.upload ? (ownMedia ? inst.media : webs) : [];
  const mediaKey = ownMedia ? key('media') : key('web');
  const workers = W.upload ? (inst.worker.length ? inst.worker : webs) : [];
  const workerKey = inst.worker.length ? key('worker') : key('web');
  const mediaEntries = !W.media ? [] : useLb ? entries : media.slice(0, 1);
  if (W.media && !useLb && inst.media.length > 1) {
    sp.push(`LB がないので、画像・動画を配るのは ${name(inst.media[0])} だけです`);
  }
  if (W.media && !ownMedia && inst.web.length) sp.push('役割「media」がないので、web が画像・動画を配っています');
  if (W.upload && !inst.worker.length && inst.web.length) sp.push('役割「worker」がないので、web が投稿を加工しています');
  if (W.search && !inst.search.length && primary !== undefined) {
    sp.push('役割「search」がないので、db が検索を肩代わりしています(LIKE 検索は重い)');
  }

  // ---- レプリカ: db を分けていれば、順番にそれぞれの db の複製にする(複製元から届くものだけ使う)
  inst.replica.forEach((r, i) => {
    if (!shards.length) return;
    const sh = shards[i % shards.length];
    if (path(sh.primary, r)) sh.replicas.push(r);
    else sp.push(`${name(r)}(レプリカ)に ${name(sh.primary)}(db)から届かないので複製できず、使われません`);
  });
  if (inst.replica.length && primary === undefined) sp.push('レプリカの複製元(db)がありません');

  // ---- 入口: ページと投稿
  const uploads = W.upload ? pv * W.upload.perPv : 0;
  const perEntry = entries.length ? (pv * lbShare) / entries.length : 0;
  const upPerEntry = entries.length ? (uploads * lbShare) / entries.length : 0;
  const upKB = W.upload?.kb ?? 0;
  for (const e of entries) {
    fromNet(e, (perEntry * WORK.requestKB + upPerEntry * upKB) * GB_PER_KB, perEntry * W.pageKB * GB_PER_KB);
  }
  const pvOf = new Map<number, number>();
  const upOf = new Map<number, number>();
  if (useLb) {
    for (const e of entries) {
      addWork(e, lbKey, perEntry + upPerEntry, lbMs(e));
      for (const w of webs) {
        const p = perEntry / webs.length;
        const u = upPerEntry / webs.length;
        send(e, w, (p * WORK.requestKB + u * upKB) * GB_PER_KB, p * W.pageKB * GB_PER_KB);
        pvOf.set(w, (pvOf.get(w) ?? 0) + p);
        upOf.set(w, (upOf.get(w) ?? 0) + u);
      }
    }
  } else {
    for (const w of webs) {
      pvOf.set(w, perEntry);
      upOf.set(w, upPerEntry);
    }
  }

  // ---- web から先
  const readsOn = new Map<number, number>();
  const searchOn = new Map<number, number>();
  const jobsOn = new Map<number, number>();
  let dbSearches = 0;
  let totalWrites = 0;
  /** db(プライマリ)ごとの書き込み */
  const writesOn = new Map<number, number>();
  for (const w of webs) {
    const wpv = pvOf.get(w) ?? 0;
    const up = upOf.get(w) ?? 0;
    addWork(w, key('web'), wpv + up, W.webCpuMs);
    const reads = wpv * W.dbReads;
    // 届く memcached に読み込みを振り分け、外れた分は db 層へ
    const cacheReach = caches.filter((c) => path(w, c));
    for (const c of cacheReach) {
      const gets = reads / cacheReach.length;
      send(w, c, gets * WORK.queryKB * GB_PER_KB, gets * WORK.dbReadKB * GB_PER_KB);
      addWork(c, key('cache'), gets, WORK.cacheCpuMs);
    }
    const toDb = cacheReach.length ? reads * (1 - WORK.cacheHitRate) : reads;
    // 書き込み: ページの書き込み(注文・コメント)と、投稿の登録
    const wr = wpv * W.dbWrites + up;
    totalWrites += wr;
    for (const sh of shards) {
      const rd = toDb * sh.read;
      const wrs = wr * sh.write;
      writesOn.set(sh.primary, (writesOn.get(sh.primary) ?? 0) + wrs);
      // 読み込みはその db のレプリカ(届くもの)に分け、なければプライマリ
      const repReach = sh.replicas.filter((r) => path(w, r));
      for (const r of repReach) {
        const n = rd / repReach.length;
        send(w, r, n * WORK.queryKB * GB_PER_KB, n * WORK.dbReadKB * GB_PER_KB);
        readsOn.set(r, (readsOn.get(r) ?? 0) + n);
      }
      const toPrimary = repReach.length ? 0 : rd;
      send(w, sh.primary, (toPrimary * WORK.queryKB + wrs * WORK.queryKB * 2) * GB_PER_KB, toPrimary * WORK.dbReadKB * GB_PER_KB);
      readsOn.set(sh.primary, (readsOn.get(sh.primary) ?? 0) + toPrimary);
    }
    // 検索: 届く search に分け、なければ db(プライマリ)が肩代わり
    if (W.search) {
      const qs = wpv * W.search.perPv;
      const reach = inst.search.filter((x) => path(w, x));
      if (reach.length) {
        for (const x of reach) {
          const n = qs / reach.length;
          send(w, x, n * WORK.queryKB * GB_PER_KB, n * W.search.resultKB * GB_PER_KB);
          searchOn.set(x, (searchOn.get(x) ?? 0) + n);
        }
      } else if (primary !== undefined) {
        send(w, primary, qs * WORK.queryKB * GB_PER_KB, qs * W.search.resultKB * GB_PER_KB);
        dbSearches += qs;
      }
    }
    // 投稿: 届く worker に元のデータを渡す
    if (W.upload && up) {
      const reach = workers.filter((k) => path(w, k));
      for (const k of reach) {
        const n = up / reach.length;
        send(w, k, n * W.upload.kb * GB_PER_KB, 0);
        jobsOn.set(k, (jobsOn.get(k) ?? 0) + n);
      }
    }
  }

  // ---- db とレプリカ: CPU と、メモリに乗らなかった読み込み・書き込みのディスク IO
  // データを分けると 1 台あたりのデータが減り、メモリに乗りやすくなる
  for (const sh of shards) {
    const p = sh.primary;
    const reads = readsOn.get(p) ?? 0;
    const writes = writesOn.get(p) ?? 0;
    const miss = missOf(p, key('db'), WORK.dbMissPerGB * sh.data);
    addWork(p, key('db'), reads, WORK.dbReadCpuMs);
    if (writes) addWork(p, key('db'), writes, WORK.dbWriteCpuMs);
    let io = reads * miss + writes * WORK.dbWriteIo;
    if (W.search && dbSearches && p === primary) {
      addWork(p, key('db'), dbSearches, W.search.dbCpuMs);
      io += dbSearches * W.search.dbIo * miss;
    }
    addIo(p, io);
    for (const r of sh.replicas) {
      const rr = readsOn.get(r) ?? 0;
      const rmiss = missOf(r, key('replica'), WORK.dbMissPerGB * sh.data);
      addWork(r, key('replica'), rr, WORK.dbReadCpuMs);
      // その db の書き込みはすべてのレプリカに複製され、反映にも CPU と IO を使う
      if (writes) {
        addCpu(r, writes, WORK.dbWriteCpuMs * REPLICATION.applyCpu);
        send(p, r, writes * WORK.queryKB * 2 * GB_PER_KB, 0);
      }
      addIo(r, rr * rmiss + writes * WORK.dbWriteIo * REPLICATION.applyIo);
    }
  }
  // ---- 検索サーバ: 索引がメモリに乗らなければディスクへ
  if (W.search) {
    for (const [x, qs] of searchOn) {
      addWork(x, key('search'), qs, W.search.cpuMs);
      addIo(x, qs * missOf(x, key('search'), W.search.missPerGB));
    }
  }
  // ---- 加工(worker)して media に保存する
  const storeOn = new Map<number, number>();
  if (W.upload) {
    for (const [k, jobs] of jobsOn) {
      // エンコードなど GPU でできる加工は、GPU があれば GPU で
      if (W.upload.workerGpuMs && hasGpu(k)) addGpuWork(k, workerKey, jobs, W.upload.workerGpuMs);
      else addWork(k, workerKey, jobs, W.upload.workerCpuMs);
      const reach = media.filter((m) => path(k, m));
      for (const m of reach) {
        const n = jobs / reach.length;
        send(k, m, n * W.upload.storedKB * GB_PER_KB, 0);
        addIo(m, n * W.upload.storeIo);
        storeOn.set(m, (storeOn.get(m) ?? 0) + n);
      }
    }
  }
  // ---- 画像・動画の配信: ページとは別のリクエストとして入口から media へ
  if (W.media) {
    const fetches = pv * W.media.perPv;
    const fetchOn = new Map<number, number>();
    const perE = mediaEntries.length ? (fetches * lbShare) / mediaEntries.length : 0;
    for (const e of mediaEntries) {
      fromNet(e, perE * WORK.requestKB * GB_PER_KB, perE * W.media.kb * GB_PER_KB);
      if (useLb) {
        addWork(e, lbKey, perE, lbMs(e));
        for (const m of media) {
          const n = perE / media.length;
          send(e, m, n * WORK.requestKB * GB_PER_KB, n * W.media.kb * GB_PER_KB);
          fetchOn.set(m, (fetchOn.get(m) ?? 0) + n);
        }
      } else fetchOn.set(e, (fetchOn.get(e) ?? 0) + perE);
    }
    for (const [m, f] of fetchOn) {
      addWork(m, mediaKey, f, W.media.cpuMs);
      addIo(m, f * W.media.io * missOf(m, mediaKey, W.media.missPerGB));
    }
  }

  // ---------------------------------------------------------------- 成功率と応答
  const evaluate = (): { success: number; latencyMs: number } => {
    const nodeOk = (id: number) => nodePass(id);
    /** db・レプリカで 1 回読む時間 */
    const readOn = (id: number, k: RoleKey) => cpuMs(id, WORK.dbReadCpuMs) + (loads.get(id)!.miss[k] ?? 1) * ioMs(id);

    const dataPart = (w: number): [number, number] => {
      if (!shards.length) return [0, 0];
      // db ごとに、読み込み(レプリカに届けばレプリカ、なければプライマリ)と書き込み(プライマリ)を見て、割合で合わせる
      let readOk = 0;
      let readMs = 0;
      let writeOk = 0;
      let writeMs = 0;
      let primaryOk = 0;
      let primaryMs = 0;
      for (const sh of shards) {
        const [netOk, netMs] = along(path(w, sh.primary));
        const pOk = netOk * nodeOk(sh.primary);
        if (sh.primary === primary) {
          primaryOk = pOk;
          primaryMs = netMs;
        }
        const reps = sh.replicas.filter((r) => path(w, r));
        if (reps.length) {
          readOk += sh.read * avg(reps.map((r) => along(path(w, r))[0] * nodeOk(r)));
          readMs += sh.read * avg(reps.map((r) => along(path(w, r))[1] + readOn(r, key('replica'))));
        } else {
          readOk += sh.read * pOk;
          readMs += sh.read * (netMs + readOn(sh.primary, key('db')));
        }
        writeOk += sh.write * pOk;
        writeMs += sh.write * (netMs + cpuMs(sh.primary, WORK.dbWriteCpuMs) + WORK.dbWriteIo * ioMs(sh.primary));
      }
      const cacheReach = caches.filter((c) => path(w, c));
      if (cacheReach.length) {
        readOk *= avg(cacheReach.map((c) => along(path(w, c))[0] * nodeOk(c)));
        const cacheMs = avg(cacheReach.map((c) => along(path(w, c))[1] + cpuMs(c, WORK.cacheCpuMs)));
        readMs = cacheMs + (1 - WORK.cacheHitRate) * readMs;
      }
      // 書き込みはプライマリだけ。書き込むページの分だけ、プライマリが溢れると失敗する
      const writeShare = Math.min(1, W.dbWrites);
      let ok = readOk * (1 - writeShare * (1 - writeOk));
      let ms = W.dbReads * readMs + W.dbWrites * writeMs;
      // 検索
      if (W.search) {
        const reach = inst.search.filter((x) => path(w, x));
        let sOk = 0;
        let sMs = 0;
        if (reach.length) {
          sOk = avg(reach.map((x) => along(path(w, x))[0] * nodeOk(x)));
          sMs = avg(reach.map((x) => along(path(w, x))[1] + cpuMs(x, W.search!.cpuMs) + (loads.get(x)!.miss[key('search')] ?? 1) * ioMs(x)));
        } else if (primary !== undefined) {
          sOk = primaryOk;
          sMs = primaryMs + cpuMs(primary, W.search.dbCpuMs) + W.search.dbIo * (loads.get(primary)!.miss[key('db')] ?? 1) * ioMs(primary);
        }
        ok *= 1 - Math.min(1, W.search.perPv) * (1 - sOk);
        ms += W.search.perPv * sMs;
      }
      return [ok, ms];
    };
    const webPart = (w: number): [number, number] => {
      const [dOk, dMs] = dataPart(w);
      return [nodeOk(w) * dOk, cpuMs(w, W.webCpuMs) + dMs];
    };

    // ページ
    let pageOk = 0;
    let pageMs = 0;
    for (const e of entries) {
      const [inOk, inMs] = fromNetAlong(e);
      let ok = 0;
      let ms = 0;
      if (useLb) {
        for (const w of webs) {
          const [pOk, pMs] = along(path(e, w));
          const [wOk, wMs] = webPart(w);
          ok += (pOk * wOk) / webs.length;
          ms += (pMs + wMs) / webs.length;
        }
        ok *= nodeOk(e);
        ms += cpuMs(e, lbMs(e));
      } else {
        [ok, ms] = webPart(e);
      }
      pageOk += (inOk * ok) / entries.length;
      pageMs += (inMs + ms) / entries.length;
    }
    let success = pageOk;
    let latency = transferMs(W.pageKB) + pageMs;

    // 画像・動画: 取得がすべて成功してはじめて 1 ページを見られる
    if (W.media) {
      const mw = W.media;
      const fetchOk = (m: number) => nodeOk(m);
      const fetchMs = (m: number) => cpuMs(m, mw.cpuMs) + mw.io * (loads.get(m)!.miss[mediaKey] ?? 1) * ioMs(m);
      let mOk = 0;
      let mMs = 0;
      for (const e of mediaEntries) {
        const [inOk, inMs] = fromNetAlong(e);
        let ok: number;
        let ms: number;
        if (useLb) {
          ok = avg(media.map((m) => along(path(e, m))[0] * fetchOk(m))) * nodeOk(e);
          ms = avg(media.map((m) => along(path(e, m))[1] + fetchMs(m))) + cpuMs(e, lbMs(e));
        } else {
          ok = fetchOk(e);
          ms = fetchMs(e);
        }
        mOk += (inOk * ok) / mediaEntries.length;
        mMs += (inMs + ms) / mediaEntries.length;
      }
      success *= mOk;
      latency += mMs + transferMs(mw.kb);
    }

    // 投稿: 入口 → web → worker → media がすべて通れば成功(応答には含めない。裏で加工する)
    if (W.upload) {
      const storeOk = (k: number) => {
        const reach = media.filter((m) => path(k, m));
        return reach.length ? avg(reach.map((m) => along(path(k, m))[0] * nodeOk(m))) : 0;
      };
      const workOk = (w: number) => {
        const reach = workers.filter((k) => path(w, k));
        return nodeOk(w) * (reach.length ? avg(reach.map((k) => along(path(w, k))[0] * nodeOk(k) * storeOk(k))) : 0);
      };
      let upOk = 0;
      for (const e of entries) {
        const [inOk] = fromNetAlong(e);
        const ok = useLb ? nodeOk(e) * avg(webs.map((w) => along(path(e, w))[0] * workOk(w))) : workOk(e);
        upOk += (inOk * ok) / entries.length;
      }
      success *= 1 - Math.min(1, W.upload.perPv) * (1 - upOk);
    }
    // 止まっている LB に来た分は失敗
    return {
      success: entries.length ? Math.max(0, Math.min(1, success * lbShare)) : pv > 0 ? 0 : 1,
      latencyMs: NET.internetRttMs + latency,
    };
  };

  // ---- 届かない所の警告
  const warnRoutes = () => {
    for (const e of entries) {
      if (handoffs.length && !linesTo(e).length) sp.push(`回線から ${name(e)} への経路がありません`);
    }
    if (useLb) {
      for (const e of entries) for (const w of webs) if (!path(e, w)) sp.push(`${name(e)}(lb)から ${name(w)}(web)への経路がありません`);
    }
    for (const sh of shards) {
      for (const w of webs) if (!path(w, sh.primary)) sp.push(`${name(w)}(web)から ${name(sh.primary)}(db)への経路がありません`);
    }
    for (const w of webs) {
      if (caches.length && !caches.some((c) => path(w, c))) {
        sp.push(`${name(w)}(web)から cache に届かないので、読み込みがすべて db 層に行きます`);
      }
      if (W.upload && !workers.some((k) => path(w, k))) sp.push(`${name(w)}(web)から投稿を加工する所に届きません`);
    }
    if (W.upload) for (const k of workers) if (!media.some((m) => path(k, m))) sp.push(`${name(k)} から加工したデータを保存する media に届きません`);
    if (useLb && W.media) {
      for (const e of entries) for (const m of media) if (!path(e, m)) sp.push(`${name(e)}(lb)から ${name(m)}(media)への経路がありません`);
    }
  };

  return { svc, inst, entries, webs, sp, evaluate, warnRoutes };
}
