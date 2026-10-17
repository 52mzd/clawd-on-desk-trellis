#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");

// Lookups normalize to lowercase, so a `1+8=9@users.noreply.github.com`
// identity such as `223556219+Copilot@...` cannot slip past an exclusion
// written in lowercase.
const IDENTITY_OVERRIDES = new Map(Object.entries({
  "rullerzhou@gmail.com": null,
  "228746293+rullerzhou-afk@users.noreply.github.com": null,
  "cursoragent@cursor.com": null,
  "noreply@anthropic.com": null,
  "cheesevickey@gmail.com": "CheeseAgent",
  "wang4433@purdue.edu": "wang4433",
  "chenbaize999@gmail.com": "shengmai-justin",
  "liufeng@dtstack.com": "liugou27",
  "akaa1941@gmail.com": "chrono-meta",
  "luis@aumentra.com": "Zamaniego",
  "kaichuan2004@gmail.com": "KaiC5504",
  "411551294@qq.com": "YOIMIYA66",
  "a1330661071@gmail.com": "xiaoshidefeng",
  "draintovmasyan783@gmail.com": "draintovmasyan783-creator",
  "264600648+draintovmasryan783-creator@users.noreply.github.com": "draintovmasyan783-creator",
  "talexdreamsoul@gmail.com": "TalexDreamSoul",
  "fxq4533@163.com": "FuZoe",
  "i@undefined.moe": "undefined-moe",
  "a1-6@1-6demacbook-air.local": "pu-1205",
  "fucdd1946523@163.com": "Tsdsj",
  "mpat@ic.ufal.br": "mantertius",
  "252015170@qq.com": "Free-LZJ",
  "shanxin@u.nus.edu": "PeterShanxin",
  "zhzhk17@gmail.com": "easyhak",
  "jason.lim@decagon.ai": "jlimcode",
  "zejian.li@exe.com": "Free-LZJ",
  "yldzfurkann0@gmail.com": "xfurqan0",
  "shiji.shi@taobao.com": "brantshin",
  "vonsdite@gmail.com": "VonSdite",
  "gzx2369563025@gmail.com": "gzx19990101",
  "lyh169347@163.com": "ypjn",
  "s.jin1448@gmail.com": "jin-codes",
  // fork-only exclusions (32c45083 follow-up): the fork's release window spans
  // official post-v1.1.0 commits whose authors upstream has not registered
  // yet (wait for upstream), plus this fork's own committer identities —
  // no upstream PR, no contributor-wall entry. (09-30 upstream sync: gzx and
  // jin now have merged upstream PRs, so their fork nulls were dropped in
  // favor of the upstream registrations above.)
  "52mzd@users.noreply.github.com": null,
  "dae@mac-studio.local": null,
  "200491821+hanzhe-one@users.noreply.github.com": null,
  // 10-03 upstream sync: upstream has not registered these merged-PR
  // authors yet (wait for upstream). LetitiaChan authored #1104 under two
  // git identities (Letty + a Tencent-machine co-author line); anupamme
  // (#1102) is already on the upstream wall; daecom2005@gmail.com is this
  // fork's author identity behind the merged upstream PRs #1085/#1086.
  "crayonchen@qq.com": "LetitiaChan",
  "letichen@tencent.com": "LetitiaChan",
  "mediratta@gmail.com": "anupamme",
  "daecom2005@gmail.com": "52mzd",
  // 10-02 upstream sync: the fork export line picked up 974e863e (stale
  // wizard callbacks) authored under the maintainer's other machine profile.
  "sean.qiu@neptune-robotics.com": null,
  // ── 上游 v1.3.0 同步补充 ──
  // 归属来源：merge commit 的 fork owner、PR 作者（GitHub API）、
  // 与贡献墙 handle 完全一致的作者名、或同一提交的 co-author。
  "jyh19310302@gmail.com": "yunho09",
  "joel.suazo@is-c.cl": "integrasoft-c",
  "ys111165542@outlook.com": "sLingli",
  "915885014@qq.com": "He-wei-gui",
  "3210102172@zju.edu.cn": "JesmonX",
  "yanqilu1997@126.com": "lurui1997",
  "kkiritoliu@tencent.com": "kkirito16",
  "yike001@e.ntu.edu.sg": "Yike-Ye",
  "ghdwls0704@gmail.com": "Tonic-Jin",
  "jason_zhihao@outlook.com": "JasonZH6600",
  "quantai520@outlook.com": "quantai1314",
  "1143409869@qq.com": "IatomicreactorI",
  "deming.zhao@bsbit.com.cn": "zhaoxv210",
  "976758426@qq.com": "serenNan",
  "1018995004@qq.com": "zxypro1",
  "rebootcrab@gmail.com": "rebootcrab-blip",
  "cod3hulk@gmail.com": "cod3hulk",
  "m0_54674331@noreply.gitcode.com": "lxgxhsy",
  "czh666nb@gmail.com": "Bynlk",
  "lyx15532388343@163.com": "ustin-star",
  "zxypro@zxyprodemacbook-air.local": "zxypro1",
  "2722273242@qq.com": "QingXB",
  "neroayase@gmail.com": "NeroAyase",
  "openclaw@agent.local": "29206394",
  "zhouxinyu3@huawei.com": "divergentD",
  "136696700@qq.com": "nmsn",
  "xiyoumc.dev@gmail.com": "xiyouMc",
  "zhengru@micous.com": "Rladmsrl",
  "zhengxiangzxxx@163.com": "XiangZheng2002",
  "me@pan93.com": "pan93412",
  "keiyoshinaga@keis-macbook-air-2.local": "keiyo118",
  "hwasowl598@gmail.com": "Hwasowl",
  "tatsuya.nakano@garoinc.jp": "tatsuyanakanogaroinc",
  "lsy3237@gmail.com": "yeonhub",
  "yang.sun.liu@gmail.com": "ssly",
  "liziqiangrui@hotmail.com": "stickycandy",
  "txie@cn.roblox.com": "TaoXieSZ",
  "liziqiang@corp.netease.com": "stickycandy",
  "yu.jiachen@outlook.com": "yujiachen-y",
  "geekweilai@gmail.com": "NeizhiTouhu",
  "zhangzhengtian02@meituan.com": "androidZzT",
  "xu3stones@xu3stonesdembp.lan": "xu3stones-cmd",
  "jasonhonghh@gmail.com": "Jasonhonghh",
  "2744423541@qq.com": "Jasonhonghh",
  "crashchen@gmail.com": "crashchen",
  "jialun.jiang@sap.com": "Tobeabellwether",
  "purefkh@gmail.com": "purefkh",
  "metazyf@gmail.com": "PixelCookie-zyf",
  "3516988334@qq.com": "git-creat7",
  "200203syttt@gmail.com": "schlaflied",
  "undownding@gmail.com": "undownding",
  "stevenchenworking@gmail.com": "godlockin",
  "georgechan233@163.com": "ne9roni",
  "linnin233@163.com": "linnin233",
  "jth8854@gmail.com": "taehwanis",
  "wujian.mailbox@gmail.com": "joshua-wu",
  "hongsaygio.com@gmail.com": "tomaioo",
  "tuananhtrinh919@gmail.com": "anhtrinh919",
  "1658378516@qq.com": "tvpoet",
  "seoki180@naver.com": "seoki180",
  "s.c.haynes@rgu.ac.uk": "sophie-haynes",
  "timmy.mi.private@gmail.com": "intimmydate",
  "yanguibao@jtexpress.com": "yanguibao1997",
  "pan93412@gmail.com": "pan93412",
  "sefuzhou770801@gmail.com": "sefuzhou770801-hub",
  "taoxie@taoxiedemac-mini-3.local": "taoxiesz",
  "roy747423@163.com": "royhuang91",
  "catan.marin@gmail.com": "sunnysonx",
  "ajb459684460@gmail.com": "Ziy1-Tan",
  "tanziyi0925@gmail.com": "Ziy1-Tan",
  "mail@bzr.ink": "Rladmsrl",
  "vadim.demkiv@gmail.com": "v-avuso",
  "akaps6768@gmail.com": "zeus6768",
  "alvinlog@kaist.ac.kr": "JaeHyeon-KAIST",
  "joshuawu.wujian@alibaba-inc.com": "joshua-wu",
  "elior513030@gmail.com": "YuChenYunn",
  // 排除：AI 工具署名与无 GitHub 账号的 co-author。
  "moonshot@moonshotdemacbook-pro.local": null,
  "223556219+copilot@users.noreply.github.com": null,
  "copilot@users.noreply.github.com": null,
  "175728472+copilot@users.noreply.github.com": null,
  "codex@openai.com": null,
  "noreply@google.com": null,
  "user@example.com": null,
  "sabinabd@amazon.com": null,
  "wenkangqiang.wkq@alibaba-inc.com": null,
}));

for (const [email, handle] of [...IDENTITY_OVERRIDES]) {
  const normalized = email.toLowerCase();
  if (normalized !== email) {
    IDENTITY_OVERRIDES.delete(email);
    if (!IDENTITY_OVERRIDES.has(normalized)) IDENTITY_OVERRIDES.set(normalized, handle);
  }
}

function parseVersion(value) {
  const match = String(value || "").match(/^v?(\d+)\.(\d+)\.(\d+)(?:-|$)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function previousReleaseTag(version, tags) {
  const current = parseVersion(version);
  if (!current) return "";
  return (Array.isArray(tags) ? tags : [])
    .map((tag) => ({ tag: String(tag).trim(), version: parseVersion(tag) }))
    .filter((entry) => entry.tag && entry.version && compareVersion(entry.version, current) < 0)
    .sort((left, right) => compareVersion(right.version, left.version))[0]?.tag || "";
}

function githubHandleForIdentity(name, email) {
  const rawEmail = String(email || "").trim();
  const normalizedEmail = rawEmail.toLowerCase();
  if (IDENTITY_OVERRIDES.has(normalizedEmail)) return IDENTITY_OVERRIDES.get(normalizedEmail);
  const noreply = rawEmail.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i);
  if (noreply) return noreply[1];
  return undefined;
}

function parseReleaseIdentities(logText) {
  const identities = [];
  for (const record of String(logText || "").split("\x1e")) {
    if (!record.trim()) continue;
    const [email = "", name = "", ...bodyParts] = record.replace(/^\n/, "").split("\x00");
    identities.push({ name: name.trim(), email: email.trim(), source: "author" });
    const body = bodyParts.join("\x00");
    for (const match of body.matchAll(/^Co-Authored-By:\s*(.*?)\s*<([^>]+)>\s*$/gim)) {
      identities.push({ name: match[1].trim(), email: match[2].trim(), source: "co-author" });
    }
  }
  return identities;
}

function loadSettingsContributors(root) {
  const source = fs.readFileSync(path.join(root, "src", "settings-i18n.js"), "utf8");
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "settings-i18n.js" });
  return Array.from(context.ClawdSettingsI18n.CONTRIBUTORS || []);
}

function verifyReleaseContributors(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, ".."));
  const version = options.version || JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const runGit = options.runGit || ((args) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // The release window spans every commit since the previous tag, each with
    // its full body (%B). A long-lived branch (a fork syncing thousands of
    // upstream commits) blows past the 1 MiB default and fails the release
    // gate with ENOBUFS, so give git room to say what it actually found.
    maxBuffer: 64 * 1024 * 1024,
  }));
  const errors = [];
  let tags = [];
  try {
    tags = runGit(["tag", "--list", "v*"]).split(/\r?\n/).filter(Boolean);
  } catch (err) {
    return { ok: false, version, previousTag: "", handles: [], errors: [`could not read release tags: ${err.message}`] };
  }
  const previousTag = previousReleaseTag(version, tags);
  if (!previousTag) {
    return { ok: false, version, previousTag: "", handles: [], errors: [`no previous release tag found before v${version}`] };
  }

  let logText = "";
  try {
    logText = runGit(["log", `${previousTag}..HEAD`, "--format=%aE%x00%aN%x00%B%x1e"]);
  } catch (err) {
    return { ok: false, version, previousTag, handles: [], errors: [`could not inspect ${previousTag}..HEAD: ${err.message}`] };
  }

  const handles = new Set();
  for (const identity of parseReleaseIdentities(logText)) {
    const handle = githubHandleForIdentity(identity.name, identity.email);
    if (handle === undefined) {
      errors.push(`unmapped ${identity.source} identity: ${identity.name} <${identity.email}>`);
    } else if (handle) {
      handles.add(handle);
    }
  }

  const contributors = new Set(loadSettingsContributors(root).map((value) => String(value).toLowerCase()));
  for (const handle of handles) {
    if (!contributors.has(handle.toLowerCase())) {
      errors.push(`release contributor @${handle} is missing from Settings About / README contributor lists`);
    }
  }

  return {
    ok: errors.length === 0,
    version,
    previousTag,
    handles: [...handles].sort((left, right) => left.localeCompare(right)),
    errors,
  };
}

function main() {
  const result = verifyReleaseContributors();
  if (!result.ok) {
    for (const error of result.errors) console.error(`Release contributor verification failed: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Release contributor contract OK: ${result.previousTag}..HEAD (${result.handles.length} external contributors)`,
  );
}

if (require.main === module) main();

module.exports = {
  githubHandleForIdentity,
  parseReleaseIdentities,
  previousReleaseTag,
  verifyReleaseContributors,
};
