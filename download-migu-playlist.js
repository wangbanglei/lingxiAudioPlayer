/**
 * 咪咕音乐歌单下载脚本
 *
 * 用法:
 *   node download-migu-playlist.js 235890246
 *   node download-migu-playlist.js --playlistId 235890246
 *   node download-migu-playlist.js -p 235890246 --playlistType create
 *
 * 说明:
 * - playlistId 通过命令行传入（必填）
 * - 直接下载歌单中的全部歌曲（自动翻页加载）
 * - 歌曲保存到「当前目录/歌单名/歌名-歌手名.mp3」
 * - 歌词保存到「当前目录/歌单名/歌名-歌手名.lrc」
 * - 封面保存到「当前目录/歌单名/歌名-歌手名.jpg」
 * - 本地已存在的完整文件会自动跳过
 * - Ctrl+C 取消时会删除当前未下载完成的临时文件
 */

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const TEMP_SUFFIX = '.part';
const COVER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

/** 当前正在下载的任务，用于取消时清理 */
let currentDownload = null;

const MIGU_KEY = Buffer.from('Jk8qzuePiJ1qE3mDYhLQ3T73DtDoAhLP');
const MAGIC = Buffer.from([0xab, 0xcd, 0x01]);

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://h5.nf.migu.cn',
  Referer: 'https://h5.nf.migu.cn/',
  ua: 'Android_migu',
  version: '6.8.8',
  channel: '014021I',
  subchannel: '014021I',
};

/** 判断本地文件是否已完整存在 */
function isFileComplete(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** 静默删除文件 */
async function removeFileQuietly(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // 文件不存在或无法删除时忽略
  }
}

/** 注册取消下载处理：Ctrl+C 时删除未完成的临时文件 */
function setupCancelHandler() {
  let handling = false;

  const handleCancel = async () => {
    if (handling) return;
    handling = true;

    if (currentDownload) {
      const { tempPath, abortController, fileStream, nodeStream } = currentDownload;
      abortController?.abort();
      fileStream?.destroy();
      nodeStream?.destroy();
      await removeFileQuietly(tempPath);
    }

    console.log('\n下载已取消，未完成的文件已删除');
    process.exit(130);
  };

  process.on('SIGINT', handleCancel);
  process.on('SIGTERM', handleCancel);
}

/** 解析命令行参数 */
function parseArgs(argv) {
  const args = { playlistId: '', playlistType: 'create' };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--playlistId' || arg === '-p') {
      args.playlistId = (argv[++i] || '').trim();
    } else if (arg === '--playlistType' || arg === '-t') {
      args.playlistType = (argv[++i] || 'create').trim();
    } else if (/^\d+$/.test(arg)) {
      args.playlistId = arg;
    }
  }

  if (!args.playlistId) {
    throw new Error(
      '请传入 playlistId，例如: node download-migu-playlist.js 235890246\n' +
        '或: node download-migu-playlist.js --playlistId 235890246'
    );
  }

  return args;
}

/** 构建歌单页面 URL */
function buildPlaylistUrl(playlistId, playlistType = 'create') {
  return `https://music.migu.cn/v5/#/playlist?playlistId=${playlistId}&playlistType=${playlistType}`;
}

/** 清理文件名非法字符（Windows） */
function sanitizeFilename(name) {
  return String(name || 'unknown')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

/** 通用 GET 请求 */
async function miguGet(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { ...DEFAULT_HEADERS, ...extraHeaders },
  });
  if (!res.ok) {
    throw new Error(`请求失败 ${res.status}: ${url}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const signature = res.headers.get('signature');
  return decryptResponse(buffer, signature);
}

/** 解密咪咕加密响应 */
function decryptResponse(buffer, signature) {
  if (
    signature === '1' ||
    (buffer.length >= 4 &&
      buffer[0] === MAGIC[0] &&
      buffer[1] === MAGIC[1] &&
      buffer[2] === MAGIC[2])
  ) {
    const seed = buffer[3];
    const plain = Buffer.alloc(buffer.length - 4);
    for (let i = 0; i < plain.length; i++) {
      plain[i] = (buffer[i + 4] + seed - MIGU_KEY[i % MIGU_KEY.length]) & 0xff;
    }
    return JSON.parse(plain.toString('utf-8'));
  }
  return JSON.parse(buffer.toString('utf-8'));
}

/** 获取歌单详情 */
async function getPlaylistInfo(playlistId) {
  const url = `https://app.c.nf.migu.cn/resource/playlist/v2.0?playlistId=${playlistId}`;
  const data = await miguGet(url);
  const info = data?.data || {};
  return {
    id: playlistId,
    title: info.title || `playlist-${playlistId}`,
    totalCount: info.totalCount || 0,
  };
}

/**
 * 分页获取歌单全部歌曲（自动翻页直到加载完毕）
 */
async function getPlaylistSongs(playlistId) {
  const pageSize = 50;
  const allSongs = [];
  const seen = new Set();
  let pageNo = 1;
  let totalCount = 0;

  while (true) {
    const url = `https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0?pageNo=${pageNo}&pageSize=${pageSize}&playlistId=${playlistId}`;
    const data = await miguGet(url);
    const songList = data?.data?.songList || [];

    if (pageNo === 1) {
      totalCount = data?.data?.totalCount || 0;
      console.log(`歌单共 ${totalCount || '?'} 首，正在加载第 1 页...`);
    } else {
      console.log(`正在加载第 ${pageNo} 页... (已加载 ${allSongs.length} 首)`);
    }

    if (!songList.length) break;

    for (const song of songList) {
      const key = song.contentId || song.copyrightId || song.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      allSongs.push(song);
    }

    if (songList.length < pageSize) break;
    if (totalCount > 0 && allSongs.length >= totalCount) break;
    pageNo += 1;
  }

  return allSongs;
}

/** 提取歌手名 */
function getSingers(song) {
  const singers = song.singers || song.singerList || [];
  const names = singers
    .map((s) => (typeof s === 'string' ? s : s?.name))
    .filter(Boolean);
  return names.join(',') || song.singerName || '未知歌手';
}

/** 获取歌曲名 */
function getSongName(song) {
  return song.name || song.songName || '未知歌曲';
}

/** 获取歌曲下载地址（优先 320k mp3） */
async function getSongDownloadUrl(song) {
  const contentId = song.contentId;
  const copyrightId = song.copyrightId;
  if (!contentId || !copyrightId) return null;

  const rateFormats = [
    ...(song.rateFormats || []),
    ...(song.newRateFormats || []),
    ...(song.audioFormats || []),
  ];

  const sortedFormats = rateFormats
    .filter((f) => f?.formatType && f?.resourceType && f.formatType !== 'Z3D')
    .sort(
      (a, b) =>
        parseFloat(String(b.size || b.androidSize || 0).replace('MB', '')) -
        parseFloat(String(a.size || a.androidSize || 0).replace('MB', ''))
    );

  const headers = {
    ...DEFAULT_HEADERS,
    'Content-Type': 'application/json;charset=UTF-8',
    birth: 'h5page',
    signature: '1',
  };

  for (const fmt of sortedFormats.length ? sortedFormats : [{ formatType: 'PQ', resourceType: '2' }]) {
    const params = new URLSearchParams({
      contentId,
      copyrightId,
      resourceType: String(fmt.resourceType),
      netType: '01',
      toneFlag: String(fmt.formatType),
      scene: '',
      lowerQualityContentId: contentId,
    });

    const url = `https://c.musicapp.migu.cn/strategy/listen-url/h5/v2.4?${params}`;
    try {
      const res = await fetch(url, { headers });
      const buffer = Buffer.from(await res.arrayBuffer());
      const result = decryptResponse(buffer, res.headers.get('signature'));
      let downloadUrl = result?.data?.url;

      if (!downloadUrl) continue;

      // 尝试升级为 320k
      downloadUrl = downloadUrl.replace(
        /\/MP3_128_16_Stero\//g,
        '/MP3_320_16_Stero/'
      );

      if (downloadUrl.startsWith('http')) {
        return downloadUrl;
      }
    } catch {
      // 尝试下一个音质
    }
  }

  // 兜底接口
  const fallback = `https://app.pd.nf.migu.cn/MIGUM3.0/v1.0/content/sub/listenSong.do?channel=mx&copyrightId=${copyrightId}&contentId=${contentId}&toneFlag=PQ&resourceType=2&netType=00`;
  return fallback;
}

/** 清理 LRC 歌词文本 */
function cleanLrc(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

/** 获取歌词下载地址 */
async function getSongLyricUrl(song) {
  if (song.lyricUrl) {
    return song.lyricUrl;
  }

  const contentId = song.contentId;
  const copyrightId = song.copyrightId;
  if (!contentId || !copyrightId) return null;

  const apiUrls = [
    `https://app.c.nf.migu.cn/MIGUM3.0/strategy/pc/listen/v1.0?scene=&netType=01&resourceType=2&copyrightId=${copyrightId}&contentId=${contentId}&toneFlag=PQ`,
    `https://music.migu.cn/v3/api/music/audioPlayer/getLyric?copyrightId=${copyrightId}&contentId=${contentId}`,
  ];

  for (const apiUrl of apiUrls) {
    try {
      const data = await miguGet(apiUrl, { Referer: 'https://music.migu.cn/' });
      const lyricUrl =
        data?.data?.lrcUrl ||
        data?.data?.lyricUrl ||
        data?.lyricUrl ||
        data?.lrcUrl;
      if (lyricUrl) return lyricUrl;
    } catch {
      // 尝试下一个接口
    }
  }

  return null;
}

/** 获取歌曲 LRC 歌词内容 */
async function getSongLyric(song) {
  const lyricUrl = await getSongLyricUrl(song);
  if (!lyricUrl) return null;

  const res = await fetch(lyricUrl, {
    headers: {
      'User-Agent': DEFAULT_HEADERS['User-Agent'],
      Referer: 'https://y.migu.cn/',
    },
    redirect: 'follow',
  });

  if (!res.ok) {
    throw new Error(`歌词下载失败 ${res.status}`);
  }

  const text = cleanLrc(await res.text());
  return text || null;
}

/** 保存歌词文件 */
async function saveLyricFile(destPath, content) {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  await fs.promises.writeFile(destPath, content, 'utf8');
}

/** 规范化封面 URL */
function normalizeCoverUrl(url) {
  if (!url) return null;
  const value = String(url).trim();
  if (!value) return null;
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  if (value.startsWith('//')) return `https:${value}`;
  return `https://d.musicapp.migu.cn${value.startsWith('/') ? '' : '/'}${value}`;
}

/** 从歌曲信息中提取封面地址 */
function getSongCoverUrl(song) {
  const imgItems = song.imgItems || [];
  const fromItems = imgItems.length ? imgItems[imgItems.length - 1]?.img : '';
  const albums = song.albums || [];
  const fromAlbum = song.album?.img || albums[0]?.img || albums[0]?.imgItems?.[0]?.img;

  const url = fromItems || song.img3 || song.img2 || song.img1 || fromAlbum || '';
  return normalizeCoverUrl(url);
}

/** 根据 URL 或 Content-Type 推断封面扩展名 */
function resolveCoverExtension(url, contentType = '') {
  const type = contentType.toLowerCase();
  if (type.includes('png')) return '.png';
  if (type.includes('webp')) return '.webp';
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';

  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (ext === '.jpeg') return '.jpg';
    if (COVER_EXTENSIONS.includes(ext)) return ext;
  } catch {
    // ignore invalid url
  }

  return '.jpg';
}

/** 查找已存在的封面文件 */
function findExistingCover(basePathWithoutExt) {
  for (const ext of COVER_EXTENSIONS) {
    const filePath = `${basePathWithoutExt}${ext === '.jpeg' ? '.jpg' : ext}`;
    const candidates =
      ext === '.jpg' ? [`${basePathWithoutExt}.jpg`, `${basePathWithoutExt}.jpeg`] : [filePath];
    for (const candidate of candidates) {
      if (isFileComplete(candidate)) return candidate;
    }
  }
  return null;
}

/** 下载歌曲封面缩略图 */
async function downloadCoverImage(url, basePathWithoutExt, abortController) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': DEFAULT_HEADERS['User-Agent'],
      Referer: 'https://music.migu.cn/',
    },
    redirect: 'follow',
    signal: abortController?.signal,
  });

  if (!res.ok) {
    throw new Error(`封面下载失败 ${res.status}`);
  }

  const ext = resolveCoverExtension(url, res.headers.get('content-type') || '');
  const destPath = `${basePathWithoutExt}${ext}`;
  const buffer = Buffer.from(await res.arrayBuffer());

  if (!buffer.length) {
    throw new Error('封面文件为空');
  }

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  await fs.promises.writeFile(destPath, buffer);
  return destPath;
}

/** 格式化字节大小 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 下载文件到本地，支持进度回调；完成后重命名，失败/取消时删除临时文件 */
async function downloadFile(url, destPath, onProgress, abortController) {
  const tempPath = `${destPath}${TEMP_SUFFIX}`;
  const signal = abortController.signal;

  await removeFileQuietly(tempPath);

  const res = await fetch(url, {
    headers: {
      'User-Agent': DEFAULT_HEADERS['User-Agent'],
      Referer: 'https://music.migu.cn/',
    },
    redirect: 'follow',
    signal,
  });

  if (!res.ok) {
    throw new Error(`下载失败 ${res.status}`);
  }

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  const total = parseInt(res.headers.get('content-length') || '0', 10);
  let downloaded = 0;
  let lastReportAt = 0;

  const report = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastReportAt < 200) return;
    lastReportAt = now;
    onProgress({ downloaded, total });
  };

  const nodeStream = Readable.fromWeb(res.body);
  const fileStream = fs.createWriteStream(tempPath);

  currentDownload = { tempPath, abortController, fileStream, nodeStream };

  try {
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        fileStream.destroy();
        nodeStream.destroy();
        reject(err);
      };

      nodeStream.on('data', (chunk) => {
        downloaded += chunk.length;
        report();
      });
      nodeStream.on('error', onError);
      fileStream.on('error', onError);
      fileStream.on('finish', resolve);
      nodeStream.pipe(fileStream);
    });

    report(true);
    await fs.promises.rename(tempPath, destPath);
  } catch (err) {
    fileStream.destroy();
    nodeStream.destroy();
    await removeFileQuietly(tempPath);
    throw err;
  } finally {
    currentDownload = null;
  }
}

/** 主流程 */
async function main() {
  setupCancelHandler();

  const { playlistId, playlistType } = parseArgs(process.argv);
  const playlistUrl = buildPlaylistUrl(playlistId, playlistType);
  const outputDir = process.cwd();

  console.log('咪咕音乐歌单下载');
  console.log(`页面地址: ${playlistUrl}`);
  console.log(`保存目录: ${outputDir}`);
  console.log('下载数量: 全部\n');

  const playlistInfo = await getPlaylistInfo(playlistId);
  const folderName = sanitizeFilename(playlistInfo.title);
  const saveDir = path.join(outputDir, folderName);

  console.log(`歌单: ${playlistInfo.title}`);
  console.log(`歌单 ID: ${playlistId}`);
  console.log(`文件夹: ${saveDir}\n`);

  const songs = await getPlaylistSongs(playlistId);
  if (!songs.length) {
    throw new Error('歌单中没有可下载的歌曲');
  }

  console.log(`\n共加载 ${songs.length} 首歌曲，开始下载...\n`);

  let success = 0;
  let failed = 0;
  let lyricSuccess = 0;
  let lyricFailed = 0;
  let lyricSkipped = 0;
  let coverSuccess = 0;
  let coverFailed = 0;
  let coverSkipped = 0;

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    const songName = getSongName(song);
    const singers = getSingers(song);
    const baseName = sanitizeFilename(`${songName}-${singers}`);
    const basePath = path.join(saveDir, baseName);
    const filePath = `${basePath}.mp3`;
    const lyricPath = `${basePath}.lrc`;
    const existingCoverPath = findExistingCover(basePath);

    const label = `[${i + 1}/${songs.length}] ${songName} - ${singers}`;
    const mp3Exists = isFileComplete(filePath);
    const lrcExists = isFileComplete(lyricPath);
    const coverExists = !!existingCoverPath;

    if (mp3Exists && lrcExists && coverExists) {
      console.log(`${label} ... 音频、歌词和封面已存在，跳过`);
      success += 1;
      lyricSkipped += 1;
      coverSkipped += 1;
      continue;
    }

    let mp3Ok = mp3Exists;
    let lrcOk = lrcExists;
    let coverOk = coverExists;
    let lyricErrorMsg = '';
    let coverErrorMsg = '';

    if (mp3Exists) {
      console.log(`${label} ... 音频已存在，跳过下载`);
    }

    const abortController = new AbortController();

    try {
      if (!mp3Exists) {
        const downloadUrl = await getSongDownloadUrl(song);
        if (!downloadUrl) {
          console.log(`${label} ... 无法获取下载链接`);
          failed += 1;
          mp3Ok = false;
        } else {
          await downloadFile(
            downloadUrl,
            filePath,
            ({ downloaded, total }) => {
              let progressText;
              if (total > 0) {
                const percent = ((downloaded / total) * 100).toFixed(1);
                progressText = `${percent}% (${formatBytes(downloaded)}/${formatBytes(total)})`;
              } else {
                progressText = formatBytes(downloaded);
              }
              process.stdout.write(`\r${label} ... ${progressText}`);
            },
            abortController
          );
          mp3Ok = true;
        }
      }

      if (!lrcExists) {
        try {
          const lyric = await getSongLyric(song);
          if (lyric) {
            await saveLyricFile(lyricPath, lyric);
            lrcOk = true;
          } else {
            lrcOk = false;
          }
        } catch (err) {
          lrcOk = false;
          lyricErrorMsg = err.message;
        }
      }

      if (!coverExists) {
        try {
          const coverUrl = getSongCoverUrl(song);
          if (coverUrl) {
            await downloadCoverImage(coverUrl, basePath, abortController);
            coverOk = true;
          } else {
            coverOk = false;
          }
        } catch (err) {
          coverOk = false;
          coverErrorMsg = err.message;
        }
      }

      const lyricStatus = lrcExists
        ? '歌词已存在'
        : lrcOk
          ? '歌词已保存'
          : lyricErrorMsg
            ? `歌词失败: ${lyricErrorMsg}`
            : '无歌词';

      const coverStatus = coverExists
        ? '封面已存在'
        : coverOk
          ? '封面已保存'
          : coverErrorMsg
            ? `封面失败: ${coverErrorMsg}`
            : '无封面';

      if (mp3Ok) {
        success += 1;
        const summary = `${lyricStatus}，${coverStatus}`;
        if (mp3Exists) {
          console.log(`${label} ... ${summary}`);
        } else {
          console.log(`\r${label} ... 完成，${summary}`);
        }
      } else if (lrcOk || coverOk) {
        console.log(`${label} ... 音频失败，${lyricStatus}，${coverStatus}`);
      }

      if (lrcExists) {
        lyricSkipped += 1;
      } else if (lrcOk) {
        lyricSuccess += 1;
      } else {
        lyricFailed += 1;
      }

      if (coverExists) {
        coverSkipped += 1;
      } else if (coverOk) {
        coverSuccess += 1;
      } else {
        coverFailed += 1;
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        throw err;
      }
      if (!mp3Ok) {
        console.log(`\r${label} ... 失败: ${err.message}`);
        failed += 1;
      }
      if (!lrcExists && !lrcOk) {
        lyricFailed += 1;
      }
      if (!coverExists && !coverOk) {
        coverFailed += 1;
      }
    }

    // 避免请求过快
    await sleep(300);
  }

  console.log(`\n下载结束: 音频成功 ${success} 首, 失败 ${failed} 首`);
  console.log(`歌词: 保存 ${lyricSuccess} 首, 跳过 ${lyricSkipped} 首, 失败/无歌词 ${lyricFailed} 首`);
  console.log(`封面: 保存 ${coverSuccess} 首, 跳过 ${coverSkipped} 首, 失败/无封面 ${coverFailed} 首`);
  console.log(`文件保存在: ${saveDir}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('\n错误:', err.message);
  process.exit(1);
});
