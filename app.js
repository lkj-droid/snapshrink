/* ==========================================================================
   SnapShrink — 100% client-side image converter, compressor & resizer
   No network calls, no uploads: everything happens in this tab.

   Sections
   1. Config & state
   2. Small helpers
   3. File intake
   4. Decoding
   5. Geometry (resize presets)
   6. Rendering & encoding
   7. Cards UI
   8. Summary / toast
   9. Downloads (single + pure-JS ZIP)
   10. Settings wiring
   11. Boot
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- 1. Config */

  var MIME = { webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png' };
  var EXT = { webp: 'webp', jpeg: 'jpg', png: 'png' };
  var QUALITY_FORMATS = { webp: true, jpeg: true, png: false };

  // Fixed-size presets. One entry per platform size the UI offers, so adding
  // another is a single line here plus an <option> in index.html.
  var PRESETS = {
    yt: { w: 1280, h: 720, label: 'YouTube thumbnail 1280×720' },
    square: { w: 1080, h: 1080, label: 'Instagram post 1080×1080' },
    story: { w: 1080, h: 1920, label: 'Instagram story 1080×1920' },
    xpost: { w: 1600, h: 900, label: 'X post 1600×900' },
    og: { w: 1200, h: 630, label: 'Link preview 1200×630' },
    pin: { w: 1000, h: 1500, label: 'Pinterest pin 1000×1500' },
    icon: { w: 512, h: 512, label: 'App icon 512×512' }
  };
  var MAX_FILES = 40;
  var MAX_DIM = 16384;
  var MAX_PIXELS = 120000000; // 120 MP guard, well under canvas limits on most devices
  var ACCEPTED = /^image\/(png|jpeg|jpg|webp|gif|bmp|x-ms-bmp)$/i;

  var DEFAULTS = {
    format: 'webp',
    quality: 82,
    preset: 'original',
    mode: 'fill',
    bg: '#ffffff',
    customW: 1280,
    customH: 720,
    lockAspect: true
  };

  var state = {
    format: DEFAULTS.format,
    quality: DEFAULTS.quality,
    preset: DEFAULTS.preset,
    mode: DEFAULTS.mode,
    bg: DEFAULTS.bg,
    customW: DEFAULTS.customW,
    customH: DEFAULTS.customH,
    lockAspect: DEFAULTS.lockAspect
  };

  var items = [];          // { id, file, name, baseName, origSize, width, height, bitmap, thumb, blob, outW, outH, outName, status, error, el }
  var encodeGen = 0;       // increments to cancel in-flight runs
  var encodingActive = false;
  var encodeTimer = null;
  var nextId = 1;
  var webpSupported = true;
  var toastTimer = null;

  /* --------------------------------------------------------------- 2. Helpers */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) {
      var kb = bytes / 1024;
      return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + ' KB';
    }
    var mb = bytes / (1024 * 1024);
    if (mb < 10) return mb.toFixed(2) + ' MB';
    if (mb < 100) return mb.toFixed(1) + ' MB';
    return Math.round(mb) + ' MB';
  }

  function baseNameOf(name) {
    return name.replace(/\.[^./\\]+$/, '') || 'image';
  }

  function safeFileName(name) {
    return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'image';
  }

  function mimeFor(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name);
    var ext = m ? m[1].toLowerCase() : '';
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'bmp') return 'image/bmp';
    return '';
  }

  function announce(text) {
    var el = $('#srStatus');
    if (el) el.textContent = text;
  }

  function toast(message, isError) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('is-error', !!isError);
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-visible'); }, isError ? 5200 : 3200);
  }

  /* ----------------------------------------------------------- 3. File intake */

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    var rejectedType = 0;
    var rejectedCount = 0;
    var candidates = [];

    files.forEach(function (file) {
      var type = file.type || mimeFor(file.name);
      if (!ACCEPTED.test(type)) { rejectedType++; return; }
      candidates.push(file);
    });

    var room = MAX_FILES - items.length;
    if (room <= 0) {
      toast('You can work on up to ' + MAX_FILES + ' images at a time. Remove a few first.', true);
      return;
    }
    if (candidates.length > room) {
      rejectedCount = candidates.length - room;
      candidates = candidates.slice(0, room);
    }

    var added = candidates.length;
    var notes = [];
    if (rejectedType) notes.push(rejectedType + ' file' + (rejectedType > 1 ? 's were' : ' was') + ' not an image');
    if (rejectedCount) notes.push(rejectedCount + ' over the ' + MAX_FILES + '-image limit');

    var batch = candidates.map(function (file) {
      var item = {
        id: nextId++,
        file: file,
        name: file.name || 'pasted-image',
        baseName: baseNameOf(file.name || 'image'),
        origSize: file.size,
        width: 0,
        height: 0,
        bitmap: null,
        thumb: '',
        blob: null,
        outW: 0,
        outH: 0,
        status: 'decoding',
        error: ''
      };
      items.push(item);
      createCard(item);
      inspectFileMeta(item);
      return item;
    });

    $('#emptyState').hidden = items.length > 0;
    $('#dropzone').classList.toggle('is-compact', items.length > 0);
    $('#workbench').classList.add('has-items');
    updateChrome();

    if (added) {
      announce(added + ' image' + (added === 1 ? '' : 's') + ' added');
      toast(added + ' image' + (added === 1 ? '' : 's') + ' added' + (notes.length ? ' · ' + notes.join(', ') : ''));
    } else if (notes.length) {
      toast(notes.join(' · '), true);
    }

    // Decode everything in this batch, then encode once (instead of restarting
    // the encoder for every file that finishes decoding).
    var decodes = batch.map(function (item) {
      return decodeItem(item).then(function () {
        updateCard(item);
        updateChrome();
      }).catch(function (err) {
        item.status = 'error';
        item.error = err && err.message ? err.message : 'This file could not be decoded';
        updateCard(item);
        updateChrome();
      });
    });

    Promise.all(decodes).then(function () {
      if (batch.some(function (i) { return i.bitmap; })) scheduleEncode(0);
    });
  }

  var decodeQueue = Promise.resolve();

  /* ------------------------------------------------ 3b. Metadata inspector
     Reads the header of the file the user just picked, in this tab, and
     reports the EXIF/GPS tags inside it. Nothing is sent anywhere — it is the
     same bytes the decoder reads. The same parser runs again on the converted
     blob, so "0 tags after convert" is measured rather than assumed. */

  var META_SCAN_LIMIT = 16 * 1024 * 1024; // headers sit at the front of every format
  var TIFF_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  function readU16(b, i, little) {
    if (i < 0 || i + 2 > b.length) return 0;
    return little ? (b[i] | (b[i + 1] << 8)) : ((b[i] << 8) | b[i + 1]);
  }

  function readU32(b, i, little) {
    if (i < 0 || i + 4 > b.length) return 0;
    return little
      ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
      : ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  }

  function readAscii(b, i, n) {
    var s = '';
    for (var k = 0; k < n && i + k < b.length; k++) {
      var c = b[i + k];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.replace(/\s+$/, '');
  }

  /** One TIFF IFD entry -> string, number or array (null when unreadable). */
  function tiffValue(b, tiff, entry, little) {
    var type = readU16(b, entry + 2, little);
    var count = readU32(b, entry + 4, little);
    var unit = TIFF_SIZES[type] || 1;
    var total = unit * count;
    var base = total <= 4 ? entry + 8 : tiff + readU32(b, entry + 8, little);
    if (!count || !base || base + total > b.length) return null;
    var out = [];
    var i, n, d;
    switch (type) {
      case 2:
        return readAscii(b, base, count);
      case 1:
      case 7:
        if (count === 1) return b[base];
        for (i = 0; i < count; i++) out.push(b[base + i]);
        return out;
      case 3:
        if (count === 1) return readU16(b, base, little);
        for (i = 0; i < count; i++) out.push(readU16(b, base + i * 2, little));
        return out;
      case 4:
        if (count === 1) return readU32(b, base, little);
        for (i = 0; i < count; i++) out.push(readU32(b, base + i * 4, little));
        return out;
      case 5:
      case 10:
        for (i = 0; i < count; i++) {
          n = readU32(b, base + i * 8, little);
          d = readU32(b, base + i * 8 + 4, little);
          if (type === 10) { n = n | 0; d = d | 0; }
          out.push(d === 0 ? 0 : n / d);
        }
        return count === 1 ? out[0] : out;
      case 9:
        if (count === 1) return readU32(b, base, little) | 0;
        for (i = 0; i < count; i++) out.push(readU32(b, base + i * 4, little) | 0);
        return out;
      case 8:
        if (count !== 1) return null;
        var v = readU16(b, base, little);
        return v > 0x7FFF ? v - 0x10000 : v;
      default:
        return null;
    }
  }

  function gpsFromTags(tags) {
    var present = Object.keys(tags).some(function (k) { return k !== '0'; });
    if (!present) return null;

    function degrees(v) {
      if (typeof v === 'number') return v;
      if (!v || !v.length || typeof v[0] !== 'number') return null;
      return v[0] + (v[1] || 0) / 60 + (v[2] || 0) / 3600;
    }

    var lat = degrees(tags[2]);
    var lon = degrees(tags[4]);
    if (lat !== null && String(tags[1] || '').toUpperCase().indexOf('S') === 0) lat = -lat;
    if (lon !== null && String(tags[3] || '').toUpperCase().indexOf('W') === 0) lon = -lon;
    return { lat: lat, lon: lon };
  }

  /** Parse one TIFF/EXIF block (as found in JPEG APP1, PNG eXIf or WebP EXIF). */
  function parseExif(b, start, meta) {
    if (start < 0 || start + 8 > b.length) return false;
    var little;
    if (b[start] === 0x49 && b[start + 1] === 0x49) little = true;
    else if (b[start] === 0x4D && b[start + 1] === 0x4D) little = false;
    else return false;
    if (readU16(b, start + 2, little) !== 0x2A) return false;
    var ifd0Offset = readU32(b, start + 4, little);
    if (!ifd0Offset || start + ifd0Offset + 2 > b.length) return false;

    var seen = {};
    function readIFD(offset) {
      if (!offset || seen[offset] || start + offset + 2 > b.length) return null;
      seen[offset] = true;
      var p = start + offset;
      var n = readU16(b, p, little);
      var tags = {};
      for (var i = 0; i < n; i++) {
        var e = p + 2 + i * 12;
        if (e + 12 > b.length) break;
        meta.tagCount++;
        var value = tiffValue(b, start, e, little);
        if (value !== null) tags[readU16(b, e, little)] = value;
      }
      return { tags: tags, next: readU32(b, p + 2 + n * 12, little) };
    }

    var ifd0 = readIFD(ifd0Offset);
    if (!ifd0) return false;
    var main = ifd0.tags;
    if (main[0x010F]) meta.make = String(main[0x010F]);
    if (main[0x0110]) meta.model = String(main[0x0110]);
    if (main[0x0112]) meta.orientation = Number(main[0x0112]) || 0;
    if (main[0x0132]) meta.date = String(main[0x0132]);
    if (main[0x0131]) meta.software = String(main[0x0131]);

    if (main[0x8769]) {
      var exifIFD = readIFD(main[0x8769]);
      if (exifIFD) {
        var t = exifIFD.tags;
        if (t[0x9003] || t[0x9004]) meta.dateTaken = String(t[0x9003] || t[0x9004]);
        if (t[0xA434]) meta.lens = String(t[0xA434]);
        if (t[0x8827]) meta.iso = Number(t[0x8827]) || 0;
        if (t[0x829D]) meta.fNumber = Number(t[0x829D]) || 0;
        if (t[0x829A]) meta.exposure = Number(t[0x829A]) || 0;
      }
    }
    if (main[0x8825]) {
      var gpsIFD = readIFD(main[0x8825]);
      if (gpsIFD) meta.gps = gpsFromTags(gpsIFD.tags);
    }
    if (ifd0.next) meta.hasThumbnail = true; // IFD1 holds the embedded preview
    return true;
  }

  function parseJpeg(b, meta) {
    var i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xFF) { i++; continue; } // resync over padding
      var marker = b[i + 1];
      if (marker === 0xFF) { i++; continue; }
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      if (marker === 0xD9 || marker === 0xDA) break; // end of image / start of scan
      var len = readU16(b, i + 2, false);
      if (len < 2) break;
      var p = i + 4;
      if (marker === 0xE1 && readAscii(b, p, 4) === 'Exif') {
        meta.hasExifBlock = true;
        parseExif(b, p + 6, meta);
      } else if (marker === 0xE1 && readAscii(b, p, 29).indexOf('http://ns.adobe.com/xap/1.0/') === 0) {
        meta.hasXmp = true;
      } else if (marker === 0xED && readAscii(b, p, 14).indexOf('Photoshop 3.0') === 0) {
        meta.hasIptc = true;
      }
      i += 2 + len;
    }
  }

  function parsePng(b, meta) {
    var i = 8;
    while (i + 8 <= b.length) {
      var len = readU32(b, i, false);
      if (len > b.length) break;
      var type = readAscii(b, i + 4, 4);
      if (type === 'eXIf') {
        meta.hasExifBlock = true;
        parseExif(b, i + 8, meta);
      } else if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
        meta.textChunks++;
      } else if (type === 'IEND') {
        break;
      }
      i += 12 + len;
    }
  }

  function parseWebp(b, meta) {
    var i = 12;
    while (i + 8 <= b.length) {
      var type = readAscii(b, i, 4);
      var size = readU32(b, i + 4, true);
      if (!size && !type) break;
      if (size > b.length) break;
      var p = i + 8;
      if (type === 'EXIF') {
        meta.hasExifBlock = true;
        var start = p;
        if (b[p] === 0x45 && b[p + 1] === 0x78 && b[p + 2] === 0x69 && b[p + 3] === 0x66) start += 6;
        parseExif(b, start, meta);
      } else if (type === 'XMP ') {
        meta.hasXmp = true;
      }
      i = p + size + (size & 1);
    }
  }

  function parseMetadata(b) {
    var meta = {
      format: '', supported: false, tagCount: 0, gps: null, make: '', model: '', lens: '',
      date: '', dateTaken: '', orientation: 0, iso: 0, fNumber: 0, exposure: 0,
      hasXmp: false, hasIptc: false, hasExifBlock: false, hasThumbnail: false, textChunks: 0
    };
    if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8) {
      meta.format = 'JPEG';
      meta.supported = true;
      parseJpeg(b, meta);
    } else if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
      meta.format = 'PNG';
      meta.supported = true;
      parsePng(b, meta);
    } else if (b.length > 12 && readAscii(b, 0, 4) === 'RIFF' && readAscii(b, 8, 4) === 'WEBP') {
      meta.format = 'WebP';
      meta.supported = true;
      parseWebp(b, meta);
    }
    return meta;
  }

  function hasMeta(meta) {
    return !!meta && meta.supported &&
      (meta.tagCount > 0 || meta.hasXmp || meta.hasIptc || meta.hasExifBlock || meta.textChunks > 0);
  }

  function metaSummary(meta) {
    var parts = [];
    if (meta.tagCount) parts.push('EXIF: ' + meta.tagCount + ' tag' + (meta.tagCount === 1 ? '' : 's'));
    if (meta.hasXmp) parts.push('XMP');
    if (meta.hasIptc) parts.push('IPTC');
    if (meta.textChunks) parts.push(meta.textChunks + ' text chunk' + (meta.textChunks === 1 ? '' : 's'));
    if (!parts.length && meta.hasExifBlock) parts.push('EXIF block');
    return parts.join(' · ');
  }

  function orientationText(value) {
    switch (value) {
      case 1: return 'Normal';
      case 2: return 'Mirrored';
      case 3: return 'Rotated 180°';
      case 4: return 'Mirrored vertically';
      case 5: return 'Mirrored and rotated 90°';
      case 6: return 'Rotated 90° clockwise';
      case 7: return 'Mirrored and rotated 270°';
      case 8: return 'Rotated 270° clockwise';
      default: return value ? 'Tag ' + value : '';
    }
  }

  function exifDate(value) {
    var m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2})/.exec(String(value || ''));
    return m ? m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] : '';
  }

  function gpsText(gps) {
    if (!gps) return '';
    if (gps.lat === null || gps.lon === null) return 'Location data present (coordinates not readable)';
    return Math.abs(gps.lat).toFixed(4) + '° ' + (gps.lat >= 0 ? 'N' : 'S') + ', ' +
      Math.abs(gps.lon).toFixed(4) + '° ' + (gps.lon >= 0 ? 'E' : 'W');
  }

  function inspectFileMeta(item) {
    var file = item.file;
    if (!file) return;
    var head = file.slice(0, Math.min(file.size, META_SCAN_LIMIT));
    head.arrayBuffer().then(function (buf) {
      item.meta = parseMetadata(new Uint8Array(buf));
      updateCard(item);
      updateChrome();
    }).catch(function () {
      item.meta = null;
      updateCard(item);
    });
  }

  /** Re-inspect what was actually encoded, so the strip is verified locally. */
  function refreshMetaOut(item) {
    var blob = item.blob;
    if (!hasMeta(item.meta) || !blob) return;
    blob.arrayBuffer().then(function (buf) {
      if (item.blob !== blob || items.indexOf(item) === -1) return;
      item.metaOut = parseMetadata(new Uint8Array(buf));
      updateCard(item);
    }).catch(function () { /* the badge simply stays unverified */ });
  }

  function renderMeta(item) {
    var el = item.el && item.el.querySelector('.meta');
    if (!el) return;
    var meta = item.meta;
    var wasOpen = !!el.querySelector('.meta-details[open]');
    el.innerHTML = '';
    if (!hasMeta(meta)) { el.hidden = true; return; }
    if (item.status === 'error') { el.hidden = true; return; }

    var tags = metaSummary(meta);
    var out = item.metaOut;
    var cleanOut = !!out && out.supported && !out.tagCount && !out.hasXmp && !out.hasIptc &&
      !out.hasExifBlock && !out.textChunks;

    el.hidden = false;
    el.dataset.format = meta.format;
    el.dataset.tags = String(meta.tagCount);
    el.dataset.gps = meta.gps ? '1' : '0';
    el.dataset.clean = cleanOut ? '1' : '0';

    var icon = document.createElement('span');
    icon.className = 'meta-icon';
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3l7 3v6c0 4.2-2.9 7.4-7 8.4C7.9 19.4 5 16.2 5 12V6l7-3Z"/></svg>';
    el.appendChild(icon);

    var line = document.createElement('span');
    line.className = 'meta-line';
    line.textContent = cleanOut ? tags + ' → 0 after convert' : tags;
    el.appendChild(line);

    if (meta.gps) {
      var gpsBadge = document.createElement('span');
      gpsBadge.className = 'badge ' + (cleanOut ? 'meta-safe' : 'meta-gps');
      gpsBadge.textContent = cleanOut ? 'GPS stripped' : 'GPS location';
      el.appendChild(gpsBadge);
    }

    var rows = [];
    var camera = [meta.make, meta.model].filter(Boolean).join(' ');
    if (meta.model && meta.make && meta.model.indexOf(meta.make) === 0) camera = meta.model;
    if (camera) rows.push(['Camera', camera]);
    if (meta.lens) rows.push(['Lens', meta.lens]);
    var taken = exifDate(meta.dateTaken || meta.date);
    if (taken) rows.push(['Taken', taken]);
    var orientation = orientationText(meta.orientation);
    if (orientation) rows.push(['Orientation', orientation]);
    var settings = [];
    if (meta.exposure) settings.push(meta.exposure < 1 ? '1/' + Math.round(1 / meta.exposure) + ' s' : meta.exposure + ' s');
    if (meta.fNumber) settings.push('f/' + (Math.round(meta.fNumber * 10) / 10));
    if (meta.iso) settings.push('ISO ' + meta.iso);
    if (settings.length) rows.push(['Settings', settings.join(' · ')]);
    var location = gpsText(meta.gps);
    if (location) rows.push(['GPS', location]);
    if (meta.hasThumbnail) rows.push(['Thumbnail', 'Embedded preview inside the file']);

    if (rows.length) {
      var details = document.createElement('details');
      details.className = 'meta-details';
      details.open = wasOpen;
      var summary = document.createElement('summary');
      summary.textContent = 'Show details';
      details.appendChild(summary);
      var dl = document.createElement('dl');
      rows.forEach(function (row) {
        var dt = document.createElement('dt');
        dt.textContent = row[0];
        var dd = document.createElement('dd');
        dd.textContent = row[1];
        dl.appendChild(dt);
        dl.appendChild(dd);
      });
      details.appendChild(dl);
      var note = document.createElement('p');
      note.className = 'meta-note';
      note.textContent = cleanOut
        ? 'The converted file has no EXIF, GPS or XMP blocks — checked in your browser.'
        : 'This is only read from the file on your device. Converting re-encodes the pixels, which drops all of it.';
      details.appendChild(note);
      el.appendChild(details);
    }
  }

  /* --------------------------------------------------------------- 4. Decoding */

  function decodeItem(item) {
    var run = function () {
      return decodeFile(item.file).then(function (result) {
        item.bitmap = result.bitmap;
        item.width = result.width;
        item.height = result.height;
        item.thumb = makeThumb(result);
        item.status = 'ready';
        return item;
      });
    };
    var p = decodeQueue.then(run, run);
    decodeQueue = p.catch(function () {});
    return p;
  }

  function decodeFile(file) {
    // Prefer createImageBitmap: it respects EXIF orientation and is faster.
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bitmap) {
        if (!bitmap.width || !bitmap.height) throw new Error('Empty image');
        return { bitmap: bitmap, width: bitmap.width, height: bitmap.height };
      }).catch(function () {
        return decodeWithImg(file);
      });
    }
    return decodeWithImg(file);
  }

  function decodeWithImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        if (!img.naturalWidth || !img.naturalHeight) {
          reject(new Error('This image has no pixel data'));
          return;
        }
        resolve({ bitmap: img, width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Unsupported or damaged file — try PNG, JPG, WebP, GIF or BMP'));
      };
      img.src = url;
    });
  }

  function makeThumb(result, size) {
    size = size || 160;
    try {
      var scale = Math.min(1, size / Math.max(result.width, result.height));
      var w = Math.max(1, Math.round(result.width * scale));
      var h = Math.max(1, Math.round(result.height * scale));
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(result.bitmap, 0, 0, result.width, result.height, 0, 0, w, h);
      var url = canvas.toDataURL('image/webp', 0.72);
      if (!url || url.indexOf('data:image/webp') !== 0) url = canvas.toDataURL('image/png');
      return url;
    } catch (e) {
      return '';
    }
  }

  /* ------------------------------------------------------------- 5. Geometry */

  function presetLabel() {
    if (PRESETS[state.preset]) return PRESETS[state.preset].label;
    switch (state.preset) {
      case 'max1920': return 'Max width 1920px';
      case 'max1080': return 'Max width 1080px';
      case 'custom': return state.lockAspect ? 'Custom width' : 'Custom size';
      default: return 'Original size';
    }
  }

  function isFixedPreset() {
    return !!PRESETS[state.preset] || (state.preset === 'custom' && !state.lockAspect);
  }

  /**
   * Work out the output canvas and where the source pixels go inside it.
   * Returns { W, H, sx, sy, cw, ch, dx, dy, dw, dh, pad }
   */
  function computeTarget(sw, sh) {
    var original = { W: sw, H: sh, sx: 0, sy: 0, cw: sw, ch: sh, dx: 0, dy: 0, dw: sw, dh: sh, pad: false };

    if (state.preset === 'original') return original;

    if (state.preset === 'max1920' || state.preset === 'max1080') {
      var maxW = state.preset === 'max1920' ? 1920 : 1080;
      if (sw <= maxW) return original;
      var s = maxW / sw;
      var h = Math.max(1, Math.round(sh * s));
      return { W: maxW, H: h, sx: 0, sy: 0, cw: sw, ch: sh, dx: 0, dy: 0, dw: maxW, dh: h, pad: false };
    }

    var W, H;
    var fixed = PRESETS[state.preset];
    if (fixed) { W = fixed.w; H = fixed.h; }
    else {
      W = clamp(Math.round(state.customW) || 1, 1, MAX_DIM);
      if (state.lockAspect) {
        var scale = W / sw;
        var oh = Math.max(1, Math.round(sh * scale));
        return { W: W, H: oh, sx: 0, sy: 0, cw: sw, ch: sh, dx: 0, dy: 0, dw: W, dh: oh, pad: false };
      }
      H = clamp(Math.round(state.customH) || 1, 1, MAX_DIM);
    }
    W = clamp(W, 1, MAX_DIM);
    H = clamp(H, 1, MAX_DIM);

    if (state.mode === 'fit') {
      var fitScale = Math.min(W / sw, H / sh);
      var fw = Math.max(1, Math.round(sw * fitScale));
      var fh = Math.max(1, Math.round(sh * fitScale));
      return {
        W: W, H: H,
        sx: 0, sy: 0, cw: sw, ch: sh,
        dx: Math.round((W - fw) / 2), dy: Math.round((H - fh) / 2),
        dw: fw, dh: fh, pad: true
      };
    }

    // Crop to fill: take the largest centred rect of the target aspect ratio.
    var targetAspect = W / H;
    var srcAspect = sw / sh;
    var cw, ch;
    if (srcAspect > targetAspect) {
      ch = sh;
      cw = Math.max(1, Math.round(sh * targetAspect));
    } else {
      cw = sw;
      ch = Math.max(1, Math.round(sw / targetAspect));
    }
    var sx = Math.max(0, Math.round((sw - cw) / 2));
    var sy = Math.max(0, Math.round((sh - ch) / 2));
    return { W: W, H: H, sx: sx, sy: sy, cw: cw, ch: ch, dx: 0, dy: 0, dw: W, dh: H, pad: false };
  }

  /* --------------------------------------------------- 6. Render & encode */

  /** Progressive halving keeps downscaled photos sharp instead of soft. */
  function prepareSource(src, sx, sy, cw, ch, dw, dh) {
    var w = Math.max(1, Math.round(cw));
    var h = Math.max(1, Math.round(ch));
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, sx, sy, cw, ch, 0, 0, w, h);

    while (w >= dw * 2 && h >= dh * 2 && w > 2 && h > 2) {
      var nw = Math.max(dw, Math.round(w / 2));
      var nh = Math.max(dh, Math.round(h / 2));
      var next = document.createElement('canvas');
      next.width = nw;
      next.height = nh;
      var nx = next.getContext('2d');
      nx.imageSmoothingEnabled = true;
      nx.imageSmoothingQuality = 'high';
      nx.drawImage(canvas, 0, 0, w, h, 0, 0, nw, nh);
      canvas = next;
      w = nw;
      h = nh;
    }
    return { canvas: canvas, w: w, h: h };
  }

  function renderCanvas(src, target, flatten, bg) {
    var canvas = document.createElement('canvas');
    canvas.width = target.W;
    canvas.height = target.H;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (flatten || target.pad) {
      ctx.fillStyle = bg || '#ffffff';
      ctx.fillRect(0, 0, target.W, target.H);
    }

    var prep = prepareSource(src, target.sx, target.sy, target.cw, target.ch, target.dw, target.dh);
    ctx.drawImage(prep.canvas, 0, 0, prep.w, prep.h, target.dx, target.dy, target.dw, target.dh);
    return canvas;
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      if (!canvas.toBlob) {
        reject(new Error('This browser cannot export images'));
        return;
      }
      canvas.toBlob(function (blob) {
        if (!blob) { reject(new Error('Encoding failed — the image may be too large')); return; }
        resolve(blob);
      }, mime, quality);
    });
  }

  function scheduleEncode(delay) {
    encodeGen++; // cancel anything running
    clearTimeout(encodeTimer);
    encodeTimer = setTimeout(runEncode, typeof delay === 'number' ? delay : 160);
  }

  function runEncode() {
    var gen = encodeGen;
    // Anything with decoded pixels can be (re-)encoded, including items whose last
    // attempt failed — changing a setting may fix them.
    var queue = items.filter(function (i) { return i.bitmap && i.width; });
    items.forEach(function (i) { markBusy(i, false); });
    if (!queue.length) { encodingActive = false; updateChrome(); return; }

    encodingActive = true;
    var mime = MIME[state.format];
    var quality = state.format === 'png' ? undefined : state.quality / 100;
    var done = 0;

    queue.forEach(function (i) {
      i.status = 'encoding';
      i.metaOut = null;
      markBusy(i, true);
      // Never offer the previous format while the new one is being produced.
      var dl = i.el && i.el.querySelector('.dl-btn');
      if (dl) dl.disabled = true;
    });

    function step(index) {
      if (gen !== encodeGen) return; // superseded by newer settings
      if (index >= queue.length) {
        queue.forEach(function (i) { markBusy(i, false); });
        encodingActive = false;
        updateChrome();
        return;
      }
      var item = queue[index];
      if (!item.bitmap || items.indexOf(item) === -1) { markBusy(item, false); step(index + 1); return; }

      // Yield so the UI can paint between images.
      setTimeout(function () {
        if (gen !== encodeGen) return;
        encodeItem(item, mime, quality).then(function () {
          if (gen !== encodeGen) return;
          item.status = 'encoded';
          item.error = '';
          markBusy(item, false);
          updateCard(item);
          refreshMetaOut(item);
          done++;
          updateCountPill(done, queue.length);
          step(index + 1);
        }).catch(function (err) {
          if (gen !== encodeGen) return;
          item.status = 'error';
          item.error = err && err.message ? err.message : 'Conversion failed';
          markBusy(item, false);
          updateCard(item);
          done++;
          step(index + 1);
        });
      }, 0);
    }

    updateCountPill(0, queue.length);
    step(0);
  }

  function encodeItem(item, mime, quality) {
    var target = computeTarget(item.width, item.height);
    var pixels = target.W * target.H;
    if (pixels > MAX_PIXELS) {
      return Promise.reject(new Error('Output would be ' + target.W + '×' + target.H + ' — too large for this device'));
    }

    var flatten = mime === MIME.jpeg;
    var canvas = renderCanvas(item.bitmap, target, flatten, state.bg);

    return canvasToBlob(canvas, mime, quality).then(function (blob) {
      if (mime === MIME.webp && blob.type !== 'image/webp') {
        // Browser silently fell back to PNG — mark WebP as unavailable.
        webpSupported = false;
        disableWebp();
        throw new Error('This browser cannot encode WebP — switched to JPEG');
      }
      item.blob = blob;
      item.outW = target.W;
      item.outH = target.H;
      item.outName = safeFileName(item.baseName) + '.' + EXT[state.format];
      // Free the full-size canvas before the next item.
      canvas.width = canvas.height = 0;
    });
  }

  /* ------------------------------------------------------------- 7. Cards UI */

  function createCard(item) {
    var article = document.createElement('article');
    article.className = 'card';
    article.dataset.id = String(item.id);
    article.innerHTML =
      '<div class="thumb"><img alt="" width="78" height="78"></div>' +
      '<div class="card-body">' +
        '<div class="card-top"><p class="name"></p></div>' +
        '<div class="dims"></div>' +
        '<div class="sizes"><span class="size-before">—</span><span class="size-arrow" aria-hidden="true">→</span><span class="size-after">—</span></div>' +
        '<div class="badges"></div>' +
        '<div class="meta" hidden></div>' +
        '<div class="card-actions">' +
          '<button class="dl-btn" type="button" disabled>' +
            '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/></svg>' +
            '<span>Download</span>' +
          '</button>' +
          '<button class="icon-btn" type="button" aria-label="Remove image" title="Remove">' +
            '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>';

    article.querySelector('.name').textContent = item.name;
    article.querySelector('.name').title = item.name;
    article.querySelector('.dl-btn').addEventListener('click', function () { downloadItem(item); });
    article.querySelector('.icon-btn').addEventListener('click', function () { removeItem(item); });

    item.el = article;
    $('#cards').appendChild(article);
    updateCard(item);
  }

  function updateCard(item) {
    var el = item.el;
    if (!el) return;
    var nameEl = el.querySelector('.name');
    var dimsEl = el.querySelector('.dims');
    var beforeEl = el.querySelector('.size-before');
    var afterEl = el.querySelector('.size-after');
    var badges = el.querySelector('.badges');
    var dl = el.querySelector('.dl-btn');
    var thumbImg = el.querySelector('.thumb img');

    nameEl.textContent = item.name;
    beforeEl.textContent = formatBytes(item.origSize);

    if (item.thumb && thumbImg.getAttribute('src') !== item.thumb) {
      thumbImg.src = item.thumb;
    } else if (!item.thumb) {
      thumbImg.removeAttribute('src');
    }
    thumbImg.alt = item.name;

    if (item.status === 'error') {
      el.classList.add('is-error');
      dimsEl.textContent = item.width ? item.width + '×' + item.height : 'Could not read image';
      afterEl.textContent = '—';
      badges.innerHTML = '';
      var errEl = document.createElement('p');
      errEl.className = 'card-error';
      errEl.textContent = item.error;
      badges.appendChild(errEl);
      dl.disabled = true;
      renderMeta(item);
      return;
    }

    el.classList.remove('is-error');

    if (!item.width) {
      dimsEl.textContent = 'Reading…';
      afterEl.textContent = '—';
      badges.innerHTML = '';
      dl.disabled = true;
      renderMeta(item);
      return;
    }

    var target = computeTarget(item.width, item.height);
    var dimsText = item.width + '×' + item.height;
    if (target.W !== item.width || target.H !== item.height) {
      dimsText += ' → ' + target.W + '×' + target.H;
    }
    dimsEl.textContent = dimsText;

    badges.innerHTML = '';
    if (item.blob) {
      afterEl.textContent = formatBytes(item.blob.size);
      dl.disabled = false;
      dl.querySelector('span').textContent = 'Download ' + EXT[state.format].toUpperCase();

      var pct = item.origSize > 0 ? Math.round((1 - item.blob.size / item.origSize) * 100) : 0;
      var badge = document.createElement('span');
      if (pct > 0) {
        badge.className = 'badge save';
        badge.textContent = '−' + pct + '% smaller';
      } else if (pct < 0) {
        badge.className = 'badge grow';
        badge.textContent = '+' + Math.abs(pct) + '% larger';
      } else {
        badge.className = 'badge neutral';
        badge.textContent = 'same size';
      }
      badges.appendChild(badge);

      if (pct < 0) {
        var tip = document.createElement('p');
        tip.className = 'card-note';
        tip.textContent = 'Try a lower quality, or keep PNG for flat graphics.';
        badges.appendChild(tip);
      } else if (target.W > item.width) {
        var up = document.createElement('p');
        up.className = 'card-note';
        up.textContent = 'Upscaled from ' + item.width + '×' + item.height + '.';
        badges.appendChild(up);
      }
    } else {
      afterEl.textContent = item.status === 'encoding' ? 'encoding…' : '—';
      dl.disabled = true;
    }

    renderMeta(item);
  }

  function markBusy(item, busy) {
    var el = item.el;
    if (!el) return;
    var thumb = el.querySelector('.thumb');
    var existing = thumb.querySelector('.busy');
    if (busy && !existing) {
      var overlay = document.createElement('div');
      overlay.className = 'busy';
      overlay.innerHTML = '<span class="spinner" role="img" aria-label="Processing"></span>';
      thumb.appendChild(overlay);
    } else if (!busy && existing) {
      existing.remove();
    }
  }

  function removeItem(item) {
    var index = items.indexOf(item);
    if (index === -1) return;
    if (item.bitmap && typeof item.bitmap.close === 'function') {
      try { item.bitmap.close(); } catch (e) { /* ignore */ }
    }
    if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el);
    items.splice(index, 1);
    if (!items.length) {
      $('#emptyState').hidden = false;
      $('#dropzone').classList.remove('is-compact');
    }
    updateChrome();
    announce('Image removed');
  }

  function clearAll() {
    items.slice().forEach(function (item) {
      if (item.bitmap && typeof item.bitmap.close === 'function') {
        try { item.bitmap.close(); } catch (e) { /* ignore */ }
      }
      if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el);
    });
    items = [];
    encodeGen++;
    clearTimeout(encodeTimer);
    $('#emptyState').hidden = false;
    $('#dropzone').classList.remove('is-compact');
    updateChrome();
    toast('All images cleared');
  }

  /* --------------------------------------------------- 8. Summary & chrome */

  function readyItems() {
    return items.filter(function (i) { return i.status === 'encoded' && i.blob; });
  }

  function updateChrome() {
    var total = items.length;
    var pill = $('#countPill');
    pill.textContent = total + (total === 1 ? ' image' : ' images');

    var summary = $('#summary');
    var ready = readyItems();
    var done = ready.length;
    var before = 0;
    var after = 0;
    items.forEach(function (i) { if (i.width) before += i.origSize; });
    ready.forEach(function (i) { after += i.blob.size; });

    if (total > 0) {
      summary.hidden = false;
      $('#sumBefore').textContent = formatBytes(before);
      $('#sumAfter').textContent = done ? formatBytes(after) : '—';
      var savedEl = $('#sumSaved');
      if (done && before > 0) {
        var pct = Math.round((1 - after / before) * 100);
        savedEl.textContent = (pct > 0 ? '−' : pct < 0 ? '+' : '') + Math.abs(pct) + '%';
        savedEl.title = (pct >= 0 ? 'Saved ' : 'Added ') + formatBytes(Math.abs(before - after));
        savedEl.classList.toggle('is-negative', pct < 0);
      } else {
        savedEl.textContent = '—';
        savedEl.title = '';
        savedEl.classList.remove('is-negative');
      }
    } else {
      summary.hidden = true;
    }

    var anyReady = done > 0;
    $('#downloadAll').disabled = !anyReady || encodingActive;

    var metaEl = $('#sumMeta');
    if (metaEl) {
      var gpsCount = 0;
      var tagged = 0;
      items.forEach(function (i) {
        if (!hasMeta(i.meta)) return;
        tagged++;
        if (i.meta.gps) gpsCount++;
      });
      if (!total) {
        metaEl.hidden = true;
      } else if (gpsCount) {
        metaEl.hidden = false;
        metaEl.textContent = 'GPS location in ' + gpsCount + ' of ' + total +
          (total === 1 ? ' image' : ' images') + ' — stripped on convert';
      } else if (tagged) {
        metaEl.hidden = false;
        metaEl.textContent = 'EXIF metadata in ' + tagged + ' of ' + total +
          (total === 1 ? ' image' : ' images') + ' — stripped on convert';
      } else {
        metaEl.hidden = false;
        metaEl.textContent = 'No EXIF or GPS metadata in these images';
      }
    }
    $('#downloadAllTop').disabled = !anyReady || encodingActive;
    $('#clearAll').disabled = total === 0;

    if (total > 0 && !anyReady && !items.some(function (i) { return i.status === 'error'; })) {
      pill.textContent = total + (total === 1 ? ' image' : ' images') + ' · encoding…';
    }
  }

  function updateCountPill(done, total) {
    var pill = $('#countPill');
    var count = items.length;
    if (done < total) {
      pill.textContent = count + (count === 1 ? ' image' : ' images') + ' · encoding ' + Math.min(done + 1, total) + '/' + total;
    } else {
      pill.textContent = count + (count === 1 ? ' image' : ' images');
    }
  }

  /* ------------------------------------------------------------ 9. Downloads */

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 1500);
  }

  function downloadItem(item) {
    if (!item.blob) return;
    triggerDownload(item.blob, item.outName || (safeFileName(item.baseName) + '.' + EXT[state.format]));
    announce('Downloading ' + item.name);
  }

  function downloadAll() {
    var ready = readyItems();
    if (!ready.length) {
      toast('Nothing to download yet', true);
      return;
    }
    var buttons = [$('#downloadAll'), $('#downloadAllTop')];
    buttons.forEach(function (b) { if (b) b.disabled = true; });
    toast(ready.length === 1 ? 'Preparing your file…' : 'Building a ZIP of ' + ready.length + ' images…');

    var used = Object.create(null);
    var entries = ready.map(function (item) {
      var name = item.outName || (safeFileName(item.baseName) + '.' + EXT[state.format]);
      if (used[name]) {
        used[name] += 1;
        var dot = name.lastIndexOf('.');
        name = name.slice(0, dot) + '-' + used[name] + name.slice(dot);
      } else {
        used[name] = 1;
      }
      return { name: name, blob: item.blob };
    });

    buildZip(entries).then(function (zipBlob) {
      var stamp = new Date().toISOString().slice(0, 10);
      var name = entries.length === 1
        ? entries[0].name
        : 'snapshrink-' + stamp + '.zip';
      triggerDownload(zipBlob, name);
      announce('Download ready: ' + name);
      toast(entries.length === 1 ? 'Download started' : entries.length + ' images saved in one ZIP');
    }).catch(function (err) {
      toast('Could not build the ZIP: ' + (err && err.message ? err.message : 'unknown error'), true);
    }).then(function () {
      updateChrome();
    });
  }

  /* ----- Minimal, dependency-free ZIP writer (stored entries, no compression) */

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function buildZip(entries) {
    var encoder = new TextEncoder();
    var now = new Date();
    var dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    var dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

    var chunks = [];
    var central = [];
    var offset = 0;

    return entries.reduce(function (chain, entry) {
      return chain.then(function () {
        return entry.blob.arrayBuffer().then(function (buffer) {
          var data = new Uint8Array(buffer);
          var nameBytes = encoder.encode(entry.name);
          var crc = crc32(data);

          var local = new Uint8Array(30 + nameBytes.length);
          var lv = new DataView(local.buffer);
          lv.setUint32(0, 0x04034b50, true);  // local file header signature
          lv.setUint16(4, 20, true);          // version needed
          lv.setUint16(6, 0x0800, true);      // UTF-8 filename flag
          lv.setUint16(8, 0, true);           // method: store
          lv.setUint16(10, dosTime, true);
          lv.setUint16(12, dosDate, true);
          lv.setUint32(14, crc, true);
          lv.setUint32(18, data.length, true); // compressed size
          lv.setUint32(22, data.length, true); // uncompressed size
          lv.setUint16(26, nameBytes.length, true);
          lv.setUint16(28, 0, true);           // extra length
          local.set(nameBytes, 30);

          chunks.push(local, data);

          var cd = new Uint8Array(46 + nameBytes.length);
          var cv = new DataView(cd.buffer);
          cv.setUint32(0, 0x02014b50, true);   // central directory signature
          cv.setUint16(4, 20, true);           // version made by
          cv.setUint16(6, 20, true);           // version needed
          cv.setUint16(8, 0x0800, true);
          cv.setUint16(10, 0, true);
          cv.setUint16(12, dosTime, true);
          cv.setUint16(14, dosDate, true);
          cv.setUint32(16, crc, true);
          cv.setUint32(20, data.length, true);
          cv.setUint32(24, data.length, true);
          cv.setUint16(28, nameBytes.length, true);
          cv.setUint16(30, 0, true);           // extra
          cv.setUint16(32, 0, true);           // comment
          cv.setUint16(34, 0, true);           // disk number
          cv.setUint16(36, 0, true);           // internal attrs
          cv.setUint32(38, 0, true);           // external attrs
          cv.setUint32(42, offset, true);      // local header offset
          cd.set(nameBytes, 46);

          central.push(cd);
          offset += local.length + data.length;
        });
      });
    }, Promise.resolve()).then(function () {
      var centralSize = central.reduce(function (sum, c) { return sum + c.length; }, 0);
      var end = new Uint8Array(22);
      var ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);     // end of central directory
      ev.setUint16(4, 0, true);
      ev.setUint16(6, 0, true);
      ev.setUint16(8, entries.length, true);
      ev.setUint16(10, entries.length, true);
      ev.setUint32(12, centralSize, true);
      ev.setUint32(16, offset, true);
      ev.setUint16(20, 0, true);

      return new Blob(chunks.concat(central, [end]), { type: 'application/zip' });
    });
  }

  /* ------------------------------------------------------- 10. Settings wiring */

  function updateRangeFill() {
    var range = $('#quality');
    var pct = ((state.quality - 10) / 90) * 100;
    range.style.setProperty('--fill', pct + '%');
  }

  function syncFormatUI() {
    var isLossless = !QUALITY_FORMATS[state.format];
    $('#quality').disabled = isLossless;
    $('#qualityField').classList.toggle('is-disabled', isLossless);

    var note = $('#formatNote');
    if (state.format === 'webp') note.textContent = 'WebP usually cuts 25–50% more than JPEG at the same quality.';
    else if (state.format === 'jpeg') note.textContent = 'JPEG is read everywhere. Transparency is flattened onto the background colour.';
    else note.textContent = 'PNG is lossless: the quality slider does not apply. Resizing is where the savings come from.';

    $('#qualityNote').textContent = isLossless
      ? 'Not used for PNG — it keeps every pixel.'
      : 'Live preview — every image is re-encoded as you drag.';

    var needsBg = state.format === 'jpeg' || (isFixedPreset() && state.mode === 'fit');
    $('#bgRow').hidden = !needsBg;
    $('#bgNote').textContent = state.format === 'jpeg'
      ? 'JPEG has no transparency, so clear areas become this colour.'
      : 'Fills the empty space around the fitted image.';
  }

  function syncResizeUI() {
    var custom = state.preset === 'custom';
    $('#customRow').hidden = !custom;
    $('#customH').disabled = state.lockAspect;
    $('#customW').value = state.customW;
    $('#customH').value = state.lockAspect ? '' : state.customH;
    $('#customH').placeholder = state.lockAspect ? 'auto' : '';
    $('#modeRow').hidden = !isFixedPreset();

    $$('.size-card').forEach(function (el) {
      var on = el.getAttribute('data-preset') === state.preset;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    var note = $('#presetNote');
    if (state.preset === 'original') note.textContent = 'Keeps the original dimensions. Max-width presets never enlarge an image.';
    else if (state.preset === 'max1920' || state.preset === 'max1080') note.textContent = 'Only shrinks images wider than the limit — smaller ones stay as they are.';
    else if (state.lockAspect && custom) note.textContent = 'Height follows each image, so nothing is cropped.';
    else note.textContent = state.mode === 'fill'
      ? 'Exact output size. The image is scaled and centre-cropped to fill it.'
      : 'Exact output size. The whole image is kept and the gaps are filled with the background colour.';

    syncFormatUI();
  }

  function onFormatChange(value) {
    if (value === 'webp' && !webpSupported) return;
    state.format = value;
    syncFormatUI();
    scheduleEncode(60);
  }

  function disableWebp() {
    var radio = $('input[name="format"][value="webp"]');
    if (radio) {
      radio.disabled = true;
      var label = radio.closest('.seg-item');
      if (label) label.title = 'This browser cannot encode WebP';
    }
    if (state.format === 'webp') {
      state.format = 'jpeg';
      var jpegRadio = $('input[name="format"][value="jpeg"]');
      if (jpegRadio) jpegRadio.checked = true;
      syncFormatUI();
    }
    toast('Your browser cannot create WebP files — JPEG is selected instead.', true);
  }

  function resetSettings() {
    state.format = DEFAULTS.format;
    state.quality = DEFAULTS.quality;
    state.preset = DEFAULTS.preset;
    state.mode = DEFAULTS.mode;
    state.bg = DEFAULTS.bg;
    state.customW = DEFAULTS.customW;
    state.customH = DEFAULTS.customH;
    state.lockAspect = DEFAULTS.lockAspect;

    var formatRadio = $('input[name="format"][value="' + state.format + '"]');
    if (formatRadio && !formatRadio.disabled) formatRadio.checked = true;
    $('#quality').value = String(state.quality);
    $('#qualityOut').textContent = state.quality + '%';
    $('#preset').value = state.preset;
    var modeRadio = $('input[name="fitmode"][value="' + state.mode + '"]');
    if (modeRadio) modeRadio.checked = true;
    $('#bgColor').value = state.bg;
    $('#lockAspect').checked = state.lockAspect;

    updateRangeFill();
    syncResizeUI();
    scheduleEncode(60);
    toast('Settings reset');
  }

  /* --------------------------------------------------------------- 11. Boot */

  function detectWebp() {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) {
          resolve(!!blob && blob.type === 'image/webp');
        }, 'image/webp', 0.8);
      });
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function init() {
    var dropzone = $('#dropzone');
    var fileInput = $('#fileInput');

    // Year
    var yearEl = $('#year');
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());

    // Theme
    var themeToggle = $('#themeToggle');
    function applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      if (themeToggle) {
        themeToggle.setAttribute('aria-label', 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme');
      }
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', theme === 'dark' ? '#070c16' : '#f6f8fc');
    }
    applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
    if (themeToggle) {
      themeToggle.addEventListener('click', function () {
        var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        try { localStorage.setItem('snapshrink-theme', next); } catch (e) { /* ignore */ }
      });
    }

    // File picker
    function openPicker() { fileInput.click(); }
    dropzone.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      openPicker();
    });
    dropzone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPicker();
      }
    });
    $('#browseBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      openPicker();
    });
    $('#addMoreBtn').addEventListener('click', openPicker);
    fileInput.addEventListener('change', function () {
      addFiles(fileInput.files);
      fileInput.value = '';
    });

    // Drag & drop
    var dragDepth = 0;
    ['dragenter', 'dragover'].forEach(function (type) {
      dropzone.addEventListener(type, function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (type === 'dragenter') dragDepth++;
        dropzone.classList.add('is-dragging');
      });
    });
    ['dragleave', 'dragend'].forEach(function (type) {
      dropzone.addEventListener(type, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) dropzone.classList.remove('is-dragging');
      });
    });
    dropzone.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      dropzone.classList.remove('is-dragging');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files);
      }
    });
    // Stop the browser from navigating away when a file is dropped elsewhere.
    ['dragover', 'drop'].forEach(function (type) {
      document.addEventListener(type, function (e) {
        if (e.target === dropzone || dropzone.contains(e.target)) return;
        if (type === 'dragover') { e.preventDefault(); return; }
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }
      });
    });

    // Paste
    document.addEventListener('paste', function (e) {
      if (!e.clipboardData) return;
      var files = Array.prototype.slice.call(e.clipboardData.files || []);
      if (!files.length) {
        var list = e.clipboardData.items || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i].kind === 'file') {
            var f = list[i].getAsFile();
            if (f) files.push(f);
          }
        }
      }
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    });

    // Format
    $$('input[name="format"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (radio.checked) onFormatChange(radio.value);
      });
    });

    // Quality
    var quality = $('#quality');
    quality.value = String(state.quality);
    quality.addEventListener('input', function () {
      state.quality = clamp(parseInt(quality.value, 10) || DEFAULTS.quality, 10, 100);
      $('#qualityOut').textContent = state.quality + '%';
      updateRangeFill();
      scheduleEncode(170);
    });

    // Preset
    $('#preset').addEventListener('change', function (e) {
      state.preset = e.target.value;
      syncResizeUI();
      scheduleEncode(60);
    });

    // Fit mode
    $$('input[name="fitmode"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        state.mode = radio.value;
        syncResizeUI();
        scheduleEncode(60);
      });
    });

    // Custom size
    $('#customW').addEventListener('input', function (e) {
      var v = parseInt(e.target.value, 10);
      if (isNaN(v)) return;
      state.customW = clamp(v, 1, MAX_DIM);
      scheduleEncode(220);
    });
    $('#customW').addEventListener('blur', function (e) {
      e.target.value = String(state.customW);
    });
    $('#customH').addEventListener('input', function (e) {
      var v = parseInt(e.target.value, 10);
      if (isNaN(v)) return;
      state.customH = clamp(v, 1, MAX_DIM);
      scheduleEncode(220);
    });
    $('#customH').addEventListener('blur', function (e) {
      e.target.value = String(state.customH);
    });
    $('#lockAspect').addEventListener('change', function (e) {
      state.lockAspect = e.target.checked;
      syncResizeUI();
      scheduleEncode(60);
    });

    // Background colour
    $('#bgColor').addEventListener('input', function (e) {
      state.bg = e.target.value;
      scheduleEncode(200);
    });

    // Platform size cards: load that size and jump to the converter
    $$('.size-card').forEach(function (card) {
      card.addEventListener('click', function () {
        var value = card.getAttribute('data-preset');
        if (!value || !$('#preset').querySelector('option[value="' + value + '"]')) return;
        state.preset = value;
        $('#preset').value = value;
        syncResizeUI();
        scheduleEncode(60);
        announce(presetLabel() + ' selected');
        var tool = $('#tool');
        if (tool) tool.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    // Buttons
    $('#downloadAll').addEventListener('click', downloadAll);
    $('#downloadAllTop').addEventListener('click', downloadAll);
    $('#clearAll').addEventListener('click', clearAll);
    $('#resetSettings').addEventListener('click', resetSettings);

    // Shortcuts: Cmd/Ctrl+O opens the picker
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        openPicker();
      }
    });

    // Warn before leaving with results not yet downloaded? Deliberately omitted:
    // the originals are untouched, and a native prompt on every link is noise.

    updateRangeFill();
    syncResizeUI();
    updateChrome();
    $('#emptyState').hidden = false;

    detectWebp().then(function (ok) {
      webpSupported = ok;
      if (!ok) disableWebp();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
