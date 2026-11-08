// CyDrums SystemCore.bin Editor - Pyodide Web App
// Runs cydrums_simple.py in browser via WebAssembly

let pyodide = null;
let extractor = null;
let systemCoreBytes = null;
let selectedWtIndex = null;
let frameCanvases = [];

// Drag state for swapping
let draggedWtIndex = null;
let draggedFrameIdx = null;
let draggedFrameWtIndex = null;

// Pyodide initialization
async function initPyodide() {
  updateStatus('Loading Pyodide runtime...');
  pyodide = await loadPyodide({
    indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/'
  });

  updateStatus('Loading wavetable engine...');
  // Load the Python module - embed cydrums_simple.py as string
  await pyodide.runPythonAsync(PYTHON_MODULE);

  updateStatus('Ready. Load a SystemCore.bin file to begin.');
  document.getElementById('file-input').disabled = false;
}

// Python module embedded as template literal
const PYTHON_MODULE = `
import struct
import wave
import os
import sys
import io

class SimpleWavetableExtractor:
    def __init__(self, bin_path):
        with open(bin_path, 'rb') as f:
            self.data = bytearray(f.read())
        self._parse()

    def _parse(self):
        if self.data[:4] != b'WTLS':
            raise ValueError("Not a valid SystemCore.bin file")

        wtls_size = struct.unpack('<I', self.data[4:8])[0]
        self.wtls_data = self.data[8:8+wtls_size]
        self.sample_start = 0x1E00

        self.names = []
        pos = 0
        while pos < len(self.wtls_data) - 8:
            tag = self.wtls_data[pos:pos+4]
            if tag == b'WTNM':
                size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                wtnm = self.wtls_data[pos+8:pos+8+size]
                _, _, name_len = struct.unpack('<III', wtnm[:12])
                name = wtnm[12:12+name_len].split(b'\\x00')[0].decode('ascii', errors='ignore')
                self.names.append(name)
                pos += 8 + size
            else:
                pos += 1

        self.load_descriptors = []
        pos = 0
        while pos < len(self.wtls_data) - 8:
            tag = self.wtls_data[pos:pos+4]
            if tag == b'WTFT':
                size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                wtft = self.wtls_data[pos+8:pos+8+size]
                if len(wtft) >= 28:
                    unk1, unk2, load_chunks, chunk_size, sample_rate, unk3, ram_size = struct.unpack('<IIIIIII', wtft[:28])
                    self.load_descriptors.append({
                        'load_chunks': load_chunks,
                        'chunk_size': chunk_size,
                        'sample_rate': sample_rate,
                        'ram_size': ram_size,
                        'num_frames': 256,
                        'frame_len': 2048,
                        'frames_per_chunk': 16,
                        'samples_per_chunk': chunk_size // 2,
                    })
                pos += 8 + size
            else:
                pos += 1

        self.offsets = []
        pos = 0
        while pos < len(self.wtls_data) - 8:
            tag = self.wtls_data[pos:pos+4]
            if tag == b'WTPL':
                size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                wtpl = self.wtls_data[pos+8:pos+8+size]
                _, _, _, offset, _, _, _ = struct.unpack('<IIIIIII', wtpl)
                self.offsets.append(offset)
                pos += 8 + size
            else:
                pos += 1

    def list_wavetables(self):
        result = []
        for i in range(64):
            if i < len(self.names) and i < len(self.load_descriptors) and i < len(self.offsets):
                d = self.load_descriptors[i]
                result.append({
                    'index': i,
                    'name': self.names[i],
                    'sample_rate': d['sample_rate'],
                    'load_chunks': d['load_chunks'],
                    'chunk_size': d['chunk_size'],
                    'ram_size': d['ram_size'],
                    'num_frames': d['num_frames'],
                    'offset': self.offsets[i]
                })
        return result

    def get_wavetable_samples(self, index):
        d = self.load_descriptors[index]
        offset = self.offsets[index]
        start = self.sample_start + offset
        end = start + d['ram_size']
        wav_data = self.data[start:end]
        return list(struct.unpack('<' + 'h' * (d['ram_size'] // 2), wav_data))

    def get_frames(self, index):
        samples = self.get_wavetable_samples(index)
        d = self.load_descriptors[index]
        frame_len = d['frame_len']
        frames = []
        for frame_idx in range(d['num_frames']):
            start = frame_idx * frame_len
            end = start + frame_len
            frames.append(list(samples[start:end]))
        return frames

    def get_frame(self, index, frame_idx):
        if frame_idx < 0 or frame_idx >= 256:
            raise ValueError("Frame index must be 0-255")
        frames = self.get_frames(index)
        return frames[frame_idx]

    def get_load_chunks(self, index):
        samples = self.get_wavetable_samples(index)
        d = self.load_descriptors[index]
        chunk_len = d['samples_per_chunk']
        chunks = []
        for c in range(d['load_chunks']):
            start = c * chunk_len
            end = start + chunk_len
            chunks.append(list(samples[start:end]))
        return chunks

    def _read_wav_raw(self, wav_path):
        """Read WAV file manually to support formats wave module doesn't (e.g., 32-bit float)."""
        with open(wav_path, 'rb') as f:
            # RIFF header
            riff = f.read(4)
            if riff != b'RIFF':
                raise ValueError("Not a RIFF file")
            file_size = struct.unpack('<I', f.read(4))[0]
            wave_id = f.read(4)
            if wave_id != b'WAVE':
                raise ValueError("Not a WAVE file")

            # Parse chunks
            nchannels = 1
            sampwidth = 2
            comptype = 'NONE'
            sr = 44100
            nframes = 0
            data = b''

            while True:
                chunk_id = f.read(4)
                if not chunk_id:
                    break
                chunk_size = struct.unpack('<I', f.read(4))[0]
                chunk_data = f.read(chunk_size)
                # Pad to even offset
                if chunk_size % 2 == 1:
                    f.read(1)

                if chunk_id == b'fmt ':
                    # fmt chunk: wFormatTag, nChannels, nSamplesPerSec, nAvgBytesPerSec, nBlockAlign, wBitsPerSample
                    if len(chunk_data) >= 16:
                        wFormatTag, nchannels, sr, nAvgBytesPerSec, nBlockAlign, wBitsPerSample = struct.unpack('<HHIIHH', chunk_data[:16])
                        sampwidth = wBitsPerSample // 8
                        # Format tag: 1=PCM, 3=IEEE float, 0xFFFE=extensible
                        if wFormatTag == 3:
                            comptype = 'FLOAT'
                        elif wFormatTag == 1:
                            comptype = 'NONE'
                        else:
                            comptype = f'UNKNOWN_{wFormatTag}'
                elif chunk_id == b'data':
                    data = chunk_data
                    nframes = len(data) // (sampwidth * nchannels)
                    break

            if not data:
                raise ValueError("No data chunk found")

            return nchannels, sampwidth, comptype, sr, nframes, data

    def load_wav(self, wav_path):
        try:
            nchannels, sampwidth, comptype, sr, nframes, frames = self._read_wav_raw(wav_path)
        except Exception:
            # Fallback to wave module for standard formats
            with wave.open(wav_path, 'rb') as wf:
                nchannels = wf.getnchannels()
                sampwidth = wf.getsampwidth()
                comptype = wf.getcomptype()
                sr = wf.getframerate()
                nframes = wf.getnframes()
                frames = wf.readframes(nframes)

        # Support multiple bit depths and formats (runs for BOTH paths)
        is_float = (comptype == 'FLOAT' or comptype == 'FL32' or comptype == 'FL64')

        if sampwidth == 1:
            # 8-bit unsigned
            samples = struct.unpack('<' + 'B' * nframes * nchannels, frames)
            samples = [(s - 128) * 256 for s in samples]
        elif sampwidth == 2:
            # 16-bit signed
            samples = struct.unpack('<' + 'h' * nframes * nchannels, frames)
        elif sampwidth == 3:
            # 24-bit signed (packed in 3 bytes)
            raw = list(frames)
            samples = []
            for i in range(0, len(raw), 3):
                if i + 2 < len(raw):
                    val = raw[i] | (raw[i+1] << 8) | (raw[i+2] << 16)
                    if val & 0x800000:
                        val -= 0x1000000
                    samples.append(val >> 8)  # Convert to 16-bit
        elif sampwidth == 4:
            if is_float:
                # 32-bit float (-1.0 to 1.0)
                samples = struct.unpack('<' + 'f' * nframes * nchannels, frames)
                samples = [int(s * 32767) for s in samples]
            else:
                # 32-bit signed int
                samples = struct.unpack('<' + 'i' * nframes * nchannels, frames)
                samples = [int(s / 65536) for s in samples]  # Convert to 16-bit
        elif sampwidth == 8 and is_float:
            # 64-bit float (rare)
            samples = struct.unpack('<' + 'd' * nframes * nchannels, frames)
            samples = [int(s * 32767) for s in samples]
        else:
            raise ValueError(f"Unsupported sample width: {sampwidth} (comptype={comptype})")

        # Convert to mono if stereo
        if nchannels == 2:
            mono_samples = []
            for i in range(0, len(samples), 2):
                if i + 1 < len(samples):
                    mono_samples.append((samples[i] + samples[i+1]) // 2)
                else:
                    mono_samples.append(samples[i])
            samples = mono_samples
        elif nchannels > 2:
            mono_samples = []
            for i in range(0, len(samples), nchannels):
                chunk = samples[i:i+nchannels]
                mono_samples.append(sum(chunk) // len(chunk))
            samples = mono_samples

        return list(samples), sr

    def load_wav_to_frame(self, wav_path, target_samples=2048):
        try:
            nchannels, sampwidth, comptype, sr, nframes, frames = self._read_wav_raw(wav_path)
        except Exception:
            # Fallback to wave module for standard formats
            with wave.open(wav_path, 'rb') as wf:
                nchannels = wf.getnchannels()
                sampwidth = wf.getsampwidth()
                comptype = wf.getcomptype()
                sr = wf.getframerate()
                nframes = wf.getnframes()
                frames = wf.readframes(nframes)

            is_float = (comptype == 'FLOAT' or comptype == 'FL32' or comptype == 'FL64')

            if sampwidth == 1:
                samples = struct.unpack('<' + 'B' * nframes * nchannels, frames)
                samples = [(s - 128) * 256 for s in samples]
            elif sampwidth == 2:
                samples = struct.unpack('<' + 'h' * nframes * nchannels, frames)
            elif sampwidth == 3:
                raw = list(frames)
                samples = []
                for i in range(0, len(raw), 3):
                    if i + 2 < len(raw):
                        val = raw[i] | (raw[i+1] << 8) | (raw[i+2] << 16)
                        if val & 0x800000:
                            val -= 0x1000000
                        samples.append(val >> 8)
            elif sampwidth == 4:
                if is_float:
                    samples = struct.unpack('<' + 'f' * nframes * nchannels, frames)
                    samples = [int(s * 32767) for s in samples]
                else:
                    samples = struct.unpack('<' + 'i' * nframes * nchannels, frames)
                    samples = [int(s / 65536) for s in samples]
            elif sampwidth == 8 and is_float:
                samples = struct.unpack('<' + 'd' * nframes * nchannels, frames)
                samples = [int(s * 32767) for s in samples]
            else:
                raise ValueError(f"Unsupported sample width: {sampwidth} (comptype={comptype})")

            if nchannels == 2:
                mono_samples = []
                for i in range(0, len(samples), 2):
                    if i + 1 < len(samples):
                        mono_samples.append((samples[i] + samples[i+1]) // 2)
                    else:
                        mono_samples.append(samples[i])
                samples = mono_samples
            elif nchannels > 2:
                mono_samples = []
                for i in range(0, len(samples), nchannels):
                    chunk = samples[i:i+nchannels]
                    mono_samples.append(sum(chunk) // len(chunk))
                samples = mono_samples

            if len(samples) != target_samples:
                if len(samples) == 0:
                    samples = [0] * target_samples
                else:
                    ratio = len(samples) / target_samples
                    resampled = []
                    for i in range(target_samples):
                        src_idx = i * ratio
                        idx_floor = int(src_idx)
                        idx_ceil = min(idx_floor + 1, len(samples) - 1)
                        frac = src_idx - idx_floor
                        val = samples[idx_floor] * (1 - frac) + samples[idx_ceil] * frac
                        resampled.append(int(val))
                    samples = resampled

        return samples, sr

    def update_wavetable(self, index, new_samples, new_name=None, new_sr=None):
        if index < 0 or index >= 64:
            raise ValueError("Index 0-63")

        d = self.load_descriptors[index]
        expected_len = d['ram_size'] // 2
        if len(new_samples) != expected_len:
            raise ValueError(f"Expected {expected_len} samples, got {len(new_samples)}")

        offset = self.offsets[index]
        start = self.sample_start + offset
        new_bytes = struct.pack('<' + 'h' * len(new_samples), *new_samples)
        self.data[start:start + d['ram_size']] = new_bytes

        if new_name:
            self._update_name(index, new_name)
            self.names[index] = new_name

        if new_sr:
            self._update_sample_rate(index, new_sr)
            self.load_descriptors[index]['sample_rate'] = new_sr

    def _update_name(self, index, new_name):
        pos = 0
        count = 0
        while pos < len(self.wtls_data) - 8:
            tag = self.wtls_data[pos:pos+4]
            if tag == b'WTNM':
                if count == index:
                    size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                    wtnm_start = pos + 8
                    name_bytes = new_name.encode('ascii') + b'\\x00'
                    name_len = min(len(name_bytes), 12)
                    new_wtnm = struct.pack('<III', 0, 1, name_len) + name_bytes.ljust(12, b'\\x00')[:12] + b'WTFT$\\x00\\x00\\x00'
                    self.wtls_data = self.wtls_data[:wtnm_start] + new_wtnm + self.wtls_data[wtnm_start+size:]
                    self.data[8:8+len(self.wtls_data)] = self.wtls_data
                    return
                count += 1
                size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                pos += 8 + size
            else:
                pos += 1

    def _update_sample_rate(self, index, new_sr):
        pos = 0
        count = 0
        while pos < len(self.wtls_data) - 8:
            tag = self.wtls_data[pos:pos+4]
            if tag == b'WTFT':
                if count == index:
                    size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                    wtft_start = pos + 8
                    wtft = bytearray(self.wtls_data[wtft_start:wtft_start+size])
                    struct.pack_into('<I', wtft, 16, new_sr)
                    self.wtls_data = self.wtls_data[:wtft_start] + bytes(wtft) + self.wtls_data[wtft_start+size:]
                    self.data[8:8+len(self.wtls_data)] = self.wtls_data
                    return
                count += 1
                size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                pos += 8 + size
            else:
                pos += 1

    def update_frame(self, wavetable_index, frame_index, new_frame_samples):
        if wavetable_index < 0 or wavetable_index >= 64:
            raise ValueError("Wavetable index must be 0-63")
        if frame_index < 0 or frame_index >= 256:
            raise ValueError("Frame index must be 0-255")

        d = self.load_descriptors[wavetable_index]
        frame_len = d['frame_len']

        if len(new_frame_samples) != frame_len:
            raise ValueError(f"Expected {frame_len} samples for frame, got {len(new_frame_samples)}")

        offset = self.offsets[wavetable_index]
        start = self.sample_start + offset + frame_index * frame_len * 2
        new_bytes = struct.pack('<' + 'h' * frame_len, *new_frame_samples)
        self.data[start:start + frame_len * 2] = new_bytes

    def swap_wavetables(self, index1, index2):
        """Swap two entire wavetables (names, load descriptors, offsets, and sample data)"""
        if index1 < 0 or index1 >= 64 or index2 < 0 or index2 >= 64:
            raise ValueError("Wavetable index must be 0-63")
        if index1 == index2:
            return

        # Swap names
        self.names[index1], self.names[index2] = self.names[index2], self.names[index1]
        self._update_name(index1, self.names[index1])
        self._update_name(index2, self.names[index2])

        # Swap load descriptors (sample rate, etc.)
        self.load_descriptors[index1], self.load_descriptors[index2] = \
            self.load_descriptors[index2], self.load_descriptors[index1]

        # Swap offsets in WTLS
        self.offsets[index1], self.offsets[index2] = self.offsets[index2], self.offsets[index1]
        self._update_offset(index1, self.offsets[index1])
        self._update_offset(index2, self.offsets[index2])

        # Swap sample data in the main data array
        d1 = self.load_descriptors[index1]
        d2 = self.load_descriptors[index2]
        start1 = self.sample_start + self.offsets[index1]
        start2 = self.sample_start + self.offsets[index2]
        size1 = d1['ram_size']
        size2 = d2['ram_size']

        # Use a temporary buffer for the swap
        temp = self.data[start1:start1 + size1]
        self.data[start1:start1 + size1] = self.data[start2:start2 + size2]
        self.data[start2:start2 + size2] = temp

    def _update_offset(self, index, new_offset):
        pos = 0
        count = 0
        while pos < len(self.wtls_data) - 8:
            tag = self.wtls_data[pos:pos+4]
            if tag == b'WTPL':
                if count == index:
                    size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                    wtpl_start = pos + 8
                    wtpl = bytearray(self.wtls_data[wtpl_start:wtpl_start+size])
                    struct.pack_into('<I', wtpl, 12, new_offset)
                    self.wtls_data = self.wtls_data[:wtpl_start] + bytes(wtpl) + self.wtls_data[wtpl_start+size:]
                    self.data[8:8+len(self.wtls_data)] = self.wtls_data
                    return
                count += 1
                size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                pos += 8 + size
            else:
                pos += 1

    def swap_frames(self, wavetable_index, frame_index1, frame_index2):
        """Swap two frames within a wavetable"""
        if wavetable_index < 0 or wavetable_index >= 64:
            raise ValueError("Wavetable index must be 0-63")
        if frame_index1 < 0 or frame_index1 >= 256 or frame_index2 < 0 or frame_index2 >= 256:
            raise ValueError("Frame index must be 0-255")
        if frame_index1 == frame_index2:
            return

        d = self.load_descriptors[wavetable_index]
        frame_len = d['frame_len']
        offset = self.offsets[wavetable_index]

        start1 = self.sample_start + offset + frame_index1 * frame_len * 2
        start2 = self.sample_start + offset + frame_index2 * frame_len * 2

        # Swap frame data
        temp = self.data[start1:start1 + frame_len * 2]
        self.data[start1:start1 + frame_len * 2] = self.data[start2:start2 + frame_len * 2]
        self.data[start2:start2 + frame_len * 2] = temp

    def save(self, path):
        with open(path, 'wb') as f:
            f.write(self.data)

def generate_sine_wavetable(sample_rate=44100, load_chunks=16, chunk_size=65536):
    import math
    total_samples = load_chunks * (chunk_size // 2)
    samples = [0] * total_samples

    samples_per_chunk = chunk_size // 2
    f0 = sample_rate / samples_per_chunk

    for c in range(load_chunks):
        chunk_start = c * samples_per_chunk
        for h in range(1, 8):
            amp = (1.0 / h) * (1.0 - c / load_chunks * 0.7)
            for i in range(samples_per_chunk):
                t = i / sample_rate
                samples[chunk_start + i] += amp * math.sin(2 * math.pi * h * f0 * t)

    max_val = max(abs(s) for s in samples)
    if max_val > 0:
        scale = 32767 / max_val
        samples = [int(s * scale) for s in samples]

    return samples
`;

// DOM Elements
const fileInput = document.getElementById('file-input');
const downloadBtn = document.getElementById('download-btn');
const sampleRateSelect = document.getElementById('sample-rate-select');
const themeSelect = document.getElementById('theme-select');
const wavetableItems = document.getElementById('wavetable-items');
const frameGrid = document.getElementById('frame-grid');
const selectedWtName = document.getElementById('selected-wt-name');
const selectedWtInfo = document.getElementById('selected-wt-info');
const noSelection = document.getElementById('no-selection');
const statusBar = document.getElementById('status-bar');

// Theme handling
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  themeSelect.value = theme;
  // Re-draw all visible canvases using cached frame data (no Python call)
  frameCanvases.forEach(({ canvas, frameData }) => {
    if (canvas.width > 0 && canvas.height > 0 && frameData) {
      drawWaveform(canvas, frameData);
    }
  });
}

function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'light';
  applyTheme(savedTheme);
  themeSelect.addEventListener('change', (e) => applyTheme(e.target.value));
}

// Event Listeners
fileInput.addEventListener('change', handleFileLoad);
downloadBtn.addEventListener('click', handleDownload);

// Initialize context menu for reliable export (works on macOS)
addContextMenuExport();

// Initialize theme
initTheme();

// Initialize
initPyodide();

function updateStatus(msg) {
  statusBar.textContent = msg;
}

function handleFileLoad(e) {
  const file = e.target.files[0];
  if (!file) return;

  updateStatus(`Loading ${file.name} (${formatBytes(file.size)})...`);

  const reader = new FileReader();
  reader.onload = async (event) => {
    systemCoreBytes = new Uint8Array(event.target.result);

    // Write to Pyodide virtual filesystem
    pyodide.FS.writeFile('/SystemCore.bin', systemCoreBytes);

    try {
      extractor = pyodide.runPython("SimpleWavetableExtractor('/SystemCore.bin')");
      // Store extractor in Python global scope for later access
      pyodide.globals.set('extractor', extractor);
      renderWavetableList();
      downloadBtn.disabled = false;
      updateStatus(`Loaded ${file.name} - 64 wavetables ready`);
    } catch (err) {
      updateStatus(`Error: ${err.message}`);
      console.error(err);
    }
  };
  reader.readAsArrayBuffer(file);
}

function renderWavetableList() {
  const wavetables = extractor.list_wavetables().toJs();

  wavetableItems.innerHTML = '';

  wavetables.forEach(wt => {
    const div = document.createElement('div');
    div.className = 'wt-item';
    div.dataset.index = wt.index;
    div.draggable = true;
    div.innerHTML = `
      <span class="wt-name">${escapeHtml(wt.name)}</span>
      <span class="wt-rate">${wt.sample_rate.toLocaleString()} Hz</span>
    `;

    div.addEventListener('click', () => selectWavetable(wt.index));

    // Swap handlers (MUST be first so dragstart runs before export handler)
    div.addEventListener('dragstart', (e) => handleDragStartWavetableSwap(e, wt.index));
    div.addEventListener('dragover', (e) => handleDragOverWavetableSwap(e, wt.index));
    div.addEventListener('dragleave', handleDragLeaveWavetableSwap);
    div.addEventListener('drop', (e) => handleDropWavetableSwap(e, wt.index));
    div.addEventListener('dragend', handleDragEndWavetableSwap);

    // File drop handlers
    div.addEventListener('dragover', handleDragOverWavetable);
    div.addEventListener('dragleave', handleDragLeaveWavetable);
    div.addEventListener('drop', handleDropOnWavetable);

    // Export handler (runs after swap, won't interfere with internal drags)
    div.addEventListener('dragstart', (e) => handleDragStartWavetable(e, wt.index));

    wavetableItems.appendChild(div);
  });
}

function selectWavetable(index) {
  // Update selection UI
  document.querySelectorAll('.wt-item').forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.index) === index);
  });

  selectedWtIndex = index;
  const wt = extractor.list_wavetables().toJs()[index];
  selectedWtName.textContent = wt.name;
  selectedWtInfo.textContent = `Index ${index} • ${wt.sample_rate.toLocaleString()} Hz • 256 frames`;

  noSelection.style.display = 'none';
  frameGrid.style.display = 'grid';

  renderFrames(index);
}

async function renderFrames(wtIndex) {
  updateStatus('Rendering frames...');

  // Get frames from Python (returns list of lists)
  const frames = extractor.get_frames(wtIndex).toJs();
  const sampleRate = extractor.load_descriptors[wtIndex].sample_rate;

  frameGrid.innerHTML = '';
  frameCanvases = [];

  // Process in chunks to avoid blocking UI
  const batchSize = 32;
  for (let i = 0; i < frames.length; i += batchSize) {
    const batch = frames.slice(i, i + batchSize);

    for (let j = 0; j < batch.length; j++) {
      const frameIdx = i + j;
      const frameData = batch[j];
      const cell = createFrameCell(frameIdx, frameData, sampleRate);
      frameGrid.appendChild(cell);
    }

    // Yield to event loop
    await new Promise(r => setTimeout(r, 0));
  }

  updateStatus(`Showing 256 frames for wavetable ${wtIndex}`);
}

function createFrameCell(frameIdx, frameData, sampleRate) {
  const cell = document.createElement('div');
  cell.className = 'frame-cell';
  cell.dataset.frameIndex = frameIdx;
  cell.draggable = true;

  const indexLabel = document.createElement('div');
  indexLabel.className = 'frame-index';
  indexLabel.textContent = `Frame ${frameIdx}`;
  cell.appendChild(indexLabel);

  const canvas = document.createElement('canvas');
  cell.appendChild(canvas);

  // Swap handlers (MUST be first so dragstart runs before export handler)
  cell.addEventListener('dragstart', (e) => handleDragStartFrameSwap(e, frameIdx));
  cell.addEventListener('dragover', (e) => handleDragOverFrameSwap(e, frameIdx));
  cell.addEventListener('dragleave', handleDragLeaveFrameSwap);
  cell.addEventListener('drop', (e) => handleDropFrameSwap(e, frameIdx));
  cell.addEventListener('dragend', handleDragEndFrameSwap);

  // File drop handlers
  cell.addEventListener('dragover', handleDragOverFrame);
  cell.addEventListener('dragleave', handleDragLeaveFrame);
  cell.addEventListener('drop', (e) => handleDropOnFrame(e, frameIdx));

  // Export handler (runs after swap, won't interfere with internal drags)
  cell.addEventListener('dragstart', (e) => handleDragStartFrame(e, frameIdx));

  // Use ResizeObserver to handle canvas sizing after layout
  const resizeObserver = new ResizeObserver(() => {
    const dpr = window.devicePixelRatio || 1;
    // Use clientHeight (inner height without borders) for accurate flex layout calculation
    const cellInnerHeight = cell.clientHeight;
    const cellInnerWidth = cell.clientWidth;
    // Account for the frame-index label height so waveform doesn't extend under the box
    const labelHeight = indexLabel.offsetHeight || 0;
    // Subtract a small buffer to ensure waveform stays inside the box
    const canvasHeight = Math.max(1, cellInnerHeight - labelHeight - 4);
    canvas.width = Math.max(1, Math.floor(cellInnerWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvasHeight * dpr));
    drawWaveform(canvas, frameData);
  });
  resizeObserver.observe(cell);

  frameCanvases.push({ cell, canvas, frameIdx, frameData, resizeObserver });

  return cell;
}

function drawWaveform(canvas, samples) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const centerY = height / 2;
  const scaleY = (height * 0.45) / 32768; // 45% of height for amplitude

  // Read theme colors from CSS variables
  const rootStyles = getComputedStyle(document.documentElement);
  const waveformColor = rootStyles.getPropertyValue('--waveform-color').trim();
  const gridColor = rootStyles.getPropertyValue('--waveform-grid').trim();
  const centerColor = rootStyles.getPropertyValue('--waveform-center').trim();

  ctx.clearRect(0, 0, width, height);

  // Background grid (center line)
  ctx.strokeStyle = centerColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(width, centerY);
  ctx.stroke();

  // Waveform
  ctx.strokeStyle = waveformColor;
  ctx.lineWidth = Math.max(1, width / 500);
  ctx.beginPath();

  const step = Math.max(1, Math.floor(samples.length / width));
  for (let x = 0; x < width; x++) {
    const idx = Math.floor(x * samples.length / width);
    const sample = samples[idx];
    const y = centerY - sample * scaleY;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// Drag-Drop Handlers
function handleDragOverWavetable(e) {
  // Ignore if swap in progress
  if (draggedWtIndex !== null) return;
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.add('drag-over');
}

function handleDragLeaveWavetable(e) {
  if (draggedWtIndex !== null) return;
  e.currentTarget.classList.remove('drag-over');
}

// ============ WAVETABLE SWAP HANDLERS ============

function handleDragStartWavetableSwap(e, wtIndex) {
  // Only handle swap if dragging from wavetable list (not file drop)
  if (e.dataTransfer.files.length > 0) return;

  draggedWtIndex = wtIndex;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', `wavetable:${wtIndex}`);
  e.currentTarget.classList.add('dragging');
}

function handleDragOverWavetableSwap(e, wtIndex) {
  if (draggedWtIndex === null || draggedWtIndex === wtIndex) return;
  if (e.dataTransfer.files.length > 0) return; // Ignore file drops

  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over-swap');
}

function handleDragLeaveWavetableSwap(e) {
  e.currentTarget.classList.remove('drag-over-swap');
}

async function handleDropWavetableSwap(e, targetWtIndex) {
  if (draggedWtIndex === null || draggedWtIndex === targetWtIndex) return;
  if (e.dataTransfer.files.length > 0) return; // Ignore file drops

  const sourceWtIndex = draggedWtIndex;

  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('drag-over-swap');

  updateStatus(`Swapping wavetable ${sourceWtIndex} with ${targetWtIndex}...`);

  try {
    await pyodide.runPythonAsync(`
extractor.swap_wavetables(${sourceWtIndex}, ${targetWtIndex})
extractor.save('/SystemCore_modified.bin')
`);

    systemCoreBytes = new Uint8Array(pyodide.FS.readFile('/SystemCore_modified.bin'));

    // Re-render list and maintain selection
    renderWavetableList();
    selectWavetable(targetWtIndex); // Select the target (now has source's data)

    updateStatus(`Swapped wavetable ${sourceWtIndex} ↔ ${targetWtIndex}`);
  } catch (err) {
    updateStatus(`Swap error: ${err.message}`);
    console.error(err);
  }
}

function handleDragEndWavetableSwap(e) {
  document.querySelectorAll('.wt-item').forEach(el => {
    el.classList.remove('dragging', 'drag-over-swap');
  });
  draggedWtIndex = null;
}

// ============ FRAME SWAP HANDLERS ============

function handleDragStartFrameSwap(e, frameIdx) {
  // Only handle swap if dragging from frame grid (not file drop)
  if (e.dataTransfer.files.length > 0) return;
  if (selectedWtIndex === null) return;

  draggedFrameIdx = frameIdx;
  draggedFrameWtIndex = selectedWtIndex;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', `frame:${selectedWtIndex}:${frameIdx}`);
  e.currentTarget.classList.add('dragging');
}

function handleDragOverFrameSwap(e, frameIdx) {
  if (draggedFrameIdx === null || draggedFrameIdx === frameIdx) return;
  if (draggedFrameWtIndex !== selectedWtIndex) return; // Only swap within same wavetable
  if (e.dataTransfer.files.length > 0) return; // Ignore file drops

  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over-swap');
}

function handleDragLeaveFrameSwap(e) {
  e.currentTarget.classList.remove('drag-over-swap');
}

async function handleDropFrameSwap(e, targetFrameIdx) {
  if (draggedFrameIdx === null || draggedFrameIdx === targetFrameIdx) return;
  if (draggedFrameWtIndex !== selectedWtIndex) return;
  if (e.dataTransfer.files.length > 0) return;

  const sourceFrameIdx = draggedFrameIdx;
  const sourceWtIndex = draggedFrameWtIndex;

  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('drag-over-swap');

  updateStatus(`Swapping frame ${sourceFrameIdx} ↔ ${targetFrameIdx}...`);

  try {
    await pyodide.runPythonAsync(`
extractor.swap_frames(${sourceWtIndex}, ${sourceFrameIdx}, ${targetFrameIdx})
extractor.save('/SystemCore_modified.bin')
`);

    systemCoreBytes = new Uint8Array(pyodide.FS.readFile('/SystemCore_modified.bin'));

    // Re-render just the two frames - use captured values, not draggedFrameIdx (reset in dragend)
    const frameData1 = extractor.get_frame(sourceWtIndex, sourceFrameIdx).toJs();
    const frameData2 = extractor.get_frame(sourceWtIndex, targetFrameIdx).toJs();

    const cell1 = frameCanvases.find(c => c.frameIdx === sourceFrameIdx);
    const cell2 = frameCanvases.find(c => c.frameIdx === targetFrameIdx);

    if (cell1) drawWaveform(cell1.canvas, frameData1);
    if (cell2) drawWaveform(cell2.canvas, frameData2);

    updateStatus(`Swapped frame ${sourceFrameIdx} ↔ ${targetFrameIdx}`);
  } catch (err) {
    updateStatus(`Swap error: ${err.message}`);
    console.error(err);
  }
}

function handleDragEndFrameSwap(e) {
  document.querySelectorAll('.frame-cell').forEach(el => {
    el.classList.remove('dragging', 'drag-over-swap');
  });
  draggedFrameIdx = null;
  draggedFrameWtIndex = null;
}

function generateWavetableName(filename) {
  // Remove extension and sanitize to 8 chars: alphanumeric only, uppercase
  const name = filename
    .replace(/\.wav$/i, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 8);
  return name || 'WAVETBL';
}

async function handleDropOnWavetable(e) {
  // Ignore if a swap operation is in progress
  if (draggedWtIndex !== null) return;

  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('drag-over');

  const wtIndex = parseInt(e.currentTarget.dataset.index);
  const file = e.dataTransfer.files[0];
  if (!file || !file.name.toLowerCase().endsWith('.wav')) {
    updateStatus('Please drop a .wav file');
    return;
  }

  const newName = generateWavetableName(file.name);
  await updateFullWavetable(wtIndex, file, newName);
}

function handleDragOverFrame(e) {
  // Ignore if swap in progress
  if (draggedFrameIdx !== null) return;
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.add('drag-over');
}

function handleDragLeaveFrame(e) {
  if (draggedFrameIdx !== null) return;
  e.currentTarget.classList.remove('drag-over');
}

async function handleDropOnFrame(e, frameIdx) {
  // Ignore if a swap operation is in progress
  if (draggedFrameIdx !== null) return;

  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('drag-over');

  const file = e.dataTransfer.files[0];
  if (!file || !file.name.toLowerCase().endsWith('.wav')) {
    updateStatus('Please drop a .wav file');
    return;
  }

  await updateSingleFrame(selectedWtIndex, frameIdx, file);
}

// Drag-out (export) handlers
async function handleDragStartWavetable(e, wtIndex) {
  // Skip export if swap in progress (drag is internal, not to Finder)
  if (draggedWtIndex !== null) return;

  try {
    // Get wavetable info
    const wtInfo = extractor.list_wavetables().toJs()[wtIndex];
    const sampleRate = wtInfo.sample_rate;
    const name = wtInfo.name || `WT${wtIndex}`;

    // Get all samples from Python
    const samples = extractor.get_wavetable_samples(wtIndex).toJs();

    // Generate WAV file
    const wavBlob = createWavBlob(samples, sampleRate);
    const filename = `${name}.wav`;

    // Set drag data for cross-platform compatibility
    setupDragData(e, wavBlob, filename, 'audio/wav');

    // Show macOS hint if needed
    if (isMacOS()) {
      updateStatus(`Dragging wavetable "${name}"... (macOS: use right-click → Export if drag doesn't work)`);
    } else {
      updateStatus(`Dragging wavetable "${name}" (${sampleRate} Hz)...`);
    }
  } catch (err) {
    updateStatus(`Error preparing export: ${err.message}`);
    console.error(err);
    e.preventDefault(); // Cancel drag if error
  }
}

async function handleDragStartFrame(e, frameIdx) {
  // Skip export if swap in progress (drag is internal, not to Finder)
  if (draggedFrameIdx !== null) return;

  try {
    if (selectedWtIndex === null) {
      e.preventDefault();
      return;
    }

    // Get wavetable info for sample rate
    const wtInfo = extractor.list_wavetables().toJs()[selectedWtIndex];
    const sampleRate = wtInfo.sample_rate;
    const wtName = wtInfo.name || `WT${selectedWtIndex}`;

    // Get frame samples from Python
    const samples = extractor.get_frame(selectedWtIndex, frameIdx).toJs();

    // Generate WAV file
    const wavBlob = createWavBlob(samples, sampleRate);
    const filename = `${wtName}_Frame${frameIdx.toString().padStart(3, '0')}.wav`;

    // Set drag data for cross-platform compatibility
    setupDragData(e, wavBlob, filename, 'audio/wav');

    // Show macOS hint if needed
    if (isMacOS()) {
      updateStatus(`Dragging frame ${frameIdx}... (macOS: use right-click → Export if drag doesn't work)`);
    } else {
      updateStatus(`Dragging frame ${frameIdx} of "${wtName}"...`);
    }
  } catch (err) {
    updateStatus(`Error preparing export: ${err.message}`);
    console.error(err);
    e.preventDefault(); // Cancel drag if error
  }
}

// Detect macOS
function isMacOS() {
  return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
}

// Set up drag data - use File API only (text formats cause .textClipping on macOS)
function setupDragData(e, blob, filename, mimeType) {
  e.dataTransfer.effectAllowed = 'copy';

  // Standard File API - this is what works for drag-out to OS
  try {
    const file = new File([blob], filename, { type: mimeType });
    e.dataTransfer.items.add(file);
  } catch (_) {
    // Ignore if not supported
  }

  // No text/uri-list or DownloadURL - they cause .textClipping files on macOS
}

// Add right-click context menu for reliable export (works everywhere including macOS)
function addContextMenuExport() {
  document.addEventListener('contextmenu', (e) => {
    const wtItem = e.target.closest('.wt-item');
    const frameCell = e.target.closest('.frame-cell');

    if (!wtItem && !frameCell) return;

    e.preventDefault();

    // Remove any existing context menu
    const existing = document.getElementById('export-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'export-context-menu';
    menu.style.top = `${e.clientY}px`;
    menu.style.left = `${e.clientX}px`;

    if (wtItem) {
      const wtIndex = parseInt(wtItem.dataset.index);
      const wtInfo = extractor.list_wavetables().toJs()[wtIndex];
      const name = wtInfo.name || `WT${wtIndex}`;

      menu.innerHTML = `
        <div class="menu-header">
          ${escapeHtml(name)} (${wtInfo.sample_rate.toLocaleString()} Hz)
        </div>
        <button data-action="export-wavetable" data-index="${wtIndex}">
          📤 Export Wavetable as WAV
        </button>
      `;
    } else if (frameCell && selectedWtIndex !== null) {
      const frameIdx = parseInt(frameCell.dataset.frameIndex);
      const wtInfo = extractor.list_wavetables().toJs()[selectedWtIndex];
      const wtName = wtInfo.name || `WT${selectedWtIndex}`;

      menu.innerHTML = `
        <div class="menu-header">
          ${escapeHtml(wtName)} - Frame ${frameIdx}
        </div>
        <button data-action="export-frame" data-index="${frameIdx}">
          📤 Export Frame as WAV
        </button>
      `;
    }

    document.body.appendChild(menu);

    // Handle clicks
    menu.addEventListener('click', async (evt) => {
      const btn = evt.target.closest('button');
      if (!btn) return;

      const action = btn.dataset.action;
      const index = parseInt(btn.dataset.index);

      menu.remove();

      if (action === 'export-wavetable') {
        await exportWavetableAsWav(index);
      } else if (action === 'export-frame') {
        await exportFrameAsWav(index);
      }
    });

    // Close on click outside
    setTimeout(() => {
      document.addEventListener('click', function closeMenu() {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      });
    }, 0);
  });
}

// Export functions for context menu
async function exportWavetableAsWav(wtIndex) {
  try {
    const wtInfo = extractor.list_wavetables().toJs()[wtIndex];
    const sampleRate = wtInfo.sample_rate;
    const name = wtInfo.name || `WT${wtIndex}`;

    const samples = extractor.get_wavetable_samples(wtIndex).toJs();
    const wavBlob = createWavBlob(samples, sampleRate);
    const filename = `${name}.wav`;

    downloadBlob(wavBlob, filename);
    updateStatus(`Exported wavetable "${name}" as ${filename}`);
  } catch (err) {
    updateStatus(`Export error: ${err.message}`);
    console.error(err);
  }
}

async function exportFrameAsWav(frameIdx) {
  try {
    if (selectedWtIndex === null) return;

    const wtInfo = extractor.list_wavetables().toJs()[selectedWtIndex];
    const sampleRate = wtInfo.sample_rate;
    const wtName = wtInfo.name || `WT${selectedWtIndex}`;

    const samples = extractor.get_frame(selectedWtIndex, frameIdx).toJs();
    const wavBlob = createWavBlob(samples, sampleRate);
    const filename = `${wtName}_Frame${frameIdx.toString().padStart(3, '0')}.wav`;

    downloadBlob(wavBlob, filename);
    updateStatus(`Exported frame ${frameIdx} as ${filename}`);
  } catch (err) {
    updateStatus(`Export error: ${err.message}`);
    console.error(err);
  }
}

// Reusable download helper
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Create a WAV file blob from int16 samples
function createWavBlob(samples, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = samples.length * 2; // 2 bytes per sample (16-bit)
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true); // File size - 8
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size (16 for PCM)
  view.setUint16(20, 1, true); // Audio format (1 = PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write sample data (int16 little-endian)
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    // Clamp to int16 range
    let sample = Math.max(-32768, Math.min(32767, Math.round(samples[i])));
    view.setInt16(offset, sample, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

async function updateFullWavetable(wtIndex, wavFile, newName) {
  updateStatus(`Updating wavetable ${wtIndex} (${newName}) with ${wavFile.name}...`);

  try {
    // Write WAV to Pyodide FS
    const arrayBuffer = await wavFile.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    pyodide.FS.writeFile('/temp.wav', uint8);

    // Process in Python - use global extractor
    const sampleRate = parseInt(sampleRateSelect.value);
    const pyResult = pyodide.runPython(`
samples, sr = extractor.load_wav('/temp.wav')
d = extractor.load_descriptors[${wtIndex}]
expected = d['ram_size'] // 2  # 524288 samples (256 frames × 2048)
frame_len = d['frame_len']     # 2048 samples per frame

# Detect how many frames in the imported WAV
imported_frames = len(samples) // frame_len
original_frames = imported_frames

if imported_frames < 256 and imported_frames > 0:
    # Duplicate frames to fill 256 frames
    frame_data = samples[:imported_frames * frame_len]
    repeats = 256 // imported_frames
    remainder = 256 % imported_frames

    # Build full 256 frames by repeating
    full_samples = []
    for _ in range(repeats):
        full_samples.extend(frame_data)
    # Add remainder frames
    if remainder > 0:
        full_samples.extend(frame_data[:remainder * frame_len])
    samples = full_samples
elif len(samples) < expected:
    # Pad with zeros if somehow still short
    samples = samples + [0] * (expected - len(samples))
elif len(samples) > expected:
    samples = samples[:expected]

extractor.update_wavetable(${wtIndex}, samples, new_name="${newName}", new_sr=${sampleRate})
extractor.save('/SystemCore_modified.bin')

# Return original frame count for status message
original_frames
    `);

    const importedFrames = pyResult;  // Already a JS number, not a proxy
    const framesInfo = importedFrames > 0 && importedFrames < 256 ? ` (${importedFrames} frames → 256 frames)` : '';
    updateStatus(`Updated wavetable ${wtIndex} (${newName}) with sample rate ${sampleRate} Hz${framesInfo}`);

    // Refresh wavetable list to show new name
    renderWavetableList();
    // Re-select the same wavetable
    selectWavetable(wtIndex);

    // Update the stored bytes for download
    systemCoreBytes = new Uint8Array(pyodide.FS.readFile('/SystemCore_modified.bin'));

    updateStatus(result);
  } catch (err) {
    updateStatus(`Error: ${err.message}`);
    console.error(err);
  }
}

async function updateSingleFrame(wtIndex, frameIdx, wavFile) {
  updateStatus(`Updating frame ${frameIdx} of wavetable ${wtIndex}...`);

  try {
    const arrayBuffer = await wavFile.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    pyodide.FS.writeFile('/temp.wav', uint8);

    pyodide.runPython(`
samples, sr = extractor.load_wav_to_frame('/temp.wav', 2048)
extractor.update_frame(${wtIndex}, ${frameIdx}, samples)
extractor.save('/SystemCore_modified.bin')
`);

    // Re-render just this frame
    const frameData = pyodide.runPython(`extractor.get_frame(${wtIndex}, ${frameIdx})`).toJs();

    const cellData = frameCanvases.find(c => c.frameIdx === frameIdx);
    if (cellData) {
      // Update cached frame data
      cellData.frameData = frameData;
      const dpr = window.devicePixelRatio || 1;
      // Use clientHeight/clientWidth (inner dimensions without borders)
      const cellInnerHeight = cellData.cell.clientHeight;
      const cellInnerWidth = cellData.cell.clientWidth;
      const labelHeight = cellData.cell.querySelector('.frame-index')?.offsetHeight || 0;
      // Subtract a small buffer to ensure waveform stays inside the box
      const canvasHeight = Math.max(1, cellInnerHeight - labelHeight - 4);
      cellData.canvas.width = Math.max(1, Math.floor(cellInnerWidth * dpr));
      cellData.canvas.height = Math.max(1, Math.floor(canvasHeight * dpr));
      drawWaveform(cellData.canvas, frameData);
    }

    systemCoreBytes = new Uint8Array(pyodide.FS.readFile('/SystemCore_modified.bin'));

    updateStatus(`Frame ${frameIdx} updated`);
  } catch (err) {
    updateStatus(`Error: ${err.message}`);
    console.error(err);
  }
}

function handleDownload() {
  if (!systemCoreBytes) return;

  const blob = new Blob([systemCoreBytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'SystemCore_modified.bin';
  a.click();
  URL.revokeObjectURL(url);

  updateStatus('Downloaded SystemCore_modified.bin');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}