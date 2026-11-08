#!/usr/bin/env python3
"""
Simple CyDrums SystemCore.bin reader/writer - no numpy/scipy required

File Format (SD Card → RAM Load Descriptor):
- WTLS (Wavetable List) header at offset 0
- 64 WTNM (Wavetable Name) entries
- 64 WTFT (Wavetable Flash Transfer) entries - RAM load descriptors
- 64 WTPL (Wavetable Playlist) entries - pointers to sample data on SD
- 32 nested WTDT entries (subset with name + load descriptor + playlist)
- Sample data starts at offset 0x1cf0 (after WTLS)
- Each wavetable: 1MB on SD = 16 load chunks × 64KB = 1MB RAM
- WTFT describes SD→RAM loading: 16 chunks of 65536 bytes each
- Hardware loads all 16 chunks sequentially from SD to RAM, then plays from RAM
- Hardware addresses 0-255 map directly to 256 frames × 2048 samples in RAM
- Total sample data on SD: 64 MB
"""

import struct
import wave
import os
import sys

class SimpleWavetableExtractor:
    def __init__(self, bin_path):
        with open(bin_path, 'rb') as f:
            self.data = bytearray(f.read())
        self._parse()

    def _parse(self):
        # Verify WTLS
        if self.data[:4] != b'WTLS':
            raise ValueError("Not a valid SystemCore.bin file")

        wtls_size = struct.unpack('<I', self.data[4:8])[0]
        self.wtls_data = self.data[8:8+wtls_size]
        # WTLS ends at 0x1CF0, but sample data actually starts at 0x1E00 (272 bytes / 136 samples later)
        # The WTPL offsets are relative to the actual sample data start
        self.sample_start = 0x1E00

        # Parse names (64 WTNM entries)
        self.names = []
        pos = 0
        while pos < len(self.wtls_data) - 8:
            tag = self.wtls_data[pos:pos+4]
            if tag == b'WTNM':
                size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                wtnm = self.wtls_data[pos+8:pos+8+size]
                _, _, name_len = struct.unpack('<III', wtnm[:12])
                name = wtnm[12:12+name_len].split(b'\x00')[0].decode('ascii', errors='ignore')
                self.names.append(name)
                pos += 8 + size
            else:
                pos += 1

        # Parse load descriptors (64 WTFT entries)
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
                        'load_chunks': load_chunks,        # 16 - number of SD load chunks
                        'chunk_size': chunk_size,          # 65536 bytes = 64KB per chunk
                        'sample_rate': sample_rate,        # Playback rate after loading to RAM
                        'ram_size': ram_size,              # 1048576 bytes = 1MB RAM needed
                        # Derived (RAM layout after loading):
                        'num_frames': 256,                 # Hardware frames (0-255) in RAM
                        'frame_len': 2048,                 # Samples per hardware frame
                        'frames_per_chunk': 16,            # 32768 / 2048 = 16 frames per chunk
                        'samples_per_chunk': chunk_size // 2,  # 32768 samples per chunk
                    })
                pos += 8 + size
            else:
                pos += 1

        # Parse offsets (64 WTPL entries)
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
        print(f"{'Idx':>3} {'Name':12s} {'Rate':>8} {'Chunks':>6} {'ChunkSize':>9} {'RAM':>8} {'Frames':>6} {'Offset':>10}")
        print("-" * 80)
        for i in range(64):
            if i < len(self.names) and i < len(self.load_descriptors) and i < len(self.offsets):
                d = self.load_descriptors[i]
                print(f"{i:3d} {self.names[i]:12s} {d['sample_rate']:8d} {d['load_chunks']:6d} {d['chunk_size']:9d} {d['ram_size']:8d} {d['num_frames']:6d} 0x{self.offsets[i]:08x}")

    def get_wavetable_samples(self, index):
        """Get all 524,288 samples for a wavetable as list of ints (RAM layout)"""
        d = self.load_descriptors[index]
        offset = self.offsets[index]
        start = self.sample_start + offset
        end = start + d['ram_size']
        wav_data = self.data[start:end]
        return struct.unpack('<' + 'h' * (d['ram_size'] // 2), wav_data)

    def get_frames(self, index):
        """Split wavetable into 256 hardware frames (2048 samples each, addressed 0-127 in RAM)"""
        samples = self.get_wavetable_samples(index)
        d = self.load_descriptors[index]
        frame_len = d['frame_len']  # 2048
        frames = []
        for frame_idx in range(d['num_frames']):  # 256
            start = frame_idx * frame_len
            end = start + frame_len
            frames.append(list(samples[start:end]))
        return frames

    def get_load_chunks(self, index):
        """Split wavetable into 16 SD load chunks (32768 samples each = 8 hardware frames)"""
        samples = self.get_wavetable_samples(index)
        d = self.load_descriptors[index]
        chunk_len = d['samples_per_chunk']  # 32768
        chunks = []
        for c in range(d['load_chunks']):  # 16
            start = c * chunk_len
            end = start + chunk_len
            chunks.append(list(samples[start:end]))
        return chunks

    def get_frame(self, index, frame_idx):
        """Get a single hardware frame (0-127) from RAM layout"""
        if frame_idx < 0 or frame_idx >= 256:
            raise ValueError("Frame index must be 0-127")
        frames = self.get_frames(index)
        return frames[frame_idx]

    def get_load_chunk(self, index, chunk_idx):
        """Get a single SD load chunk (0-15)"""
        if chunk_idx < 0 or chunk_idx >= 16:
            raise ValueError("Load chunk index must be 0-15")
        chunks = self.get_load_chunks(index)
        return chunks[chunk_idx]

    def analyze_waveform_cycles(self, index):
        """Analyze actual acoustic waveform cycles in the wavetable (RAM layout)"""
        samples = self.get_wavetable_samples(index)

        # Count zero crossings
        pos_zc = sum(1 for i in range(1, len(samples)) if samples[i-1] <= 0 and samples[i] > 0)
        neg_zc = sum(1 for i in range(1, len(samples)) if samples[i-1] >= 0 and samples[i] < 0)
        total_zc = pos_zc + neg_zc
        acoustic_cycles = total_zc // 2
        samples_per_cycle = len(samples) / acoustic_cycles if acoustic_cycles > 0 else 0

        d = self.load_descriptors[index]
        return {
            'acoustic_cycles': acoustic_cycles,
            'samples_per_acoustic_cycle': samples_per_cycle,
            'hardware_frames': d['num_frames'],           # 256
            'samples_per_frame': d['frame_len'],          # 2048
            'load_chunks': d['load_chunks'],              # 16
            'samples_per_chunk': d['samples_per_chunk'],  # 32768
            'acoustic_cycles_per_frame': acoustic_cycles / d['num_frames'],
            'acoustic_cycles_per_chunk': acoustic_cycles / d['load_chunks'],
        }

    def extract_wav(self, index, out_dir):
        """Extract single wavetable as WAV (full RAM layout)"""
        os.makedirs(out_dir, exist_ok=True)
        d = self.load_descriptors[index]
        samples = self.get_wavetable_samples(index)
        out_path = os.path.join(out_dir, f"{index:02d}_{self.names[index]}.wav")
        with wave.open(out_path, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(d['sample_rate'])
            wf.writeframes(struct.pack('<' + 'h' * len(samples), *samples))
        print(f"Saved: {out_path}")

    def extract_all_wav(self, out_dir):
        """Extract all as WAV"""
        for i in range(64):
            self.extract_wav(i, out_dir)

    def extract_frames_wav(self, index, out_dir):
        """Extract all 256 hardware frames as separate WAV files (RAM layout)"""
        wt_name = self.names[index].replace(' ', '_').replace('/', '_')
        wt_dir = os.path.join(out_dir, f"{index:02d}_{wt_name}")
        os.makedirs(wt_dir, exist_ok=True)
        d = self.load_descriptors[index]
        frames = self.get_frames(index)
        for frame_idx, frame in enumerate(frames):
            out_path = os.path.join(wt_dir, f"frame{frame_idx:03d}.wav")
            with wave.open(out_path, 'wb') as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(d['sample_rate'])
                wf.writeframes(struct.pack('<' + 'h' * len(frame), *frame))
        print(f"Saved {len(frames)} frames to {wt_dir}")

    def extract_load_chunks_wav(self, index, out_dir):
        """Extract 16 SD load chunks as separate WAV files"""
        os.makedirs(out_dir, exist_ok=True)
        d = self.load_descriptors[index]
        chunks = self.get_load_chunks(index)
        for c, chunk in enumerate(chunks):
            out_path = os.path.join(out_dir, f"{index:02d}_{self.names[index]}_chunk{c:02d}.wav")
            with wave.open(out_path, 'wb') as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(d['sample_rate'])
                wf.writeframes(struct.pack('<' + 'h' * len(chunk), *chunk))
        print(f"Saved {len(chunks)} load chunks to {out_dir}")

    def extract_all_frames(self, out_dir):
        """Extract all 64 wavetables as 256 hardware frames each (subfolder per wavetable)"""
        os.makedirs(out_dir, exist_ok=True)
        total = 0
        for i in range(64):
            wt_name = self.names[i].replace(' ', '_').replace('/', '_')
            wt_dir = os.path.join(out_dir, f"{i:02d}_{wt_name}")
            os.makedirs(wt_dir, exist_ok=True)
            d = self.load_descriptors[i]
            frames = self.get_frames(i)
            for frame_idx, frame in enumerate(frames):
                out_path = os.path.join(wt_dir, f"frame{frame_idx:03d}.wav")
                with wave.open(out_path, 'wb') as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(d['sample_rate'])
                    wf.writeframes(struct.pack('<' + 'h' * len(frame), *frame))
            total += len(frames)
        print(f"Saved {total} frames (64 wavetables × 256 frames) to {out_dir}/")

    def extract_all_load_chunks(self, out_dir):
        """Extract all 64 wavetables as 16 load chunks each (subfolder per wavetable)"""
        os.makedirs(out_dir, exist_ok=True)
        total = 0
        for i in range(64):
            wt_name = self.names[i].replace(' ', '_').replace('/', '_')
            wt_dir = os.path.join(out_dir, f"{i:02d}_{wt_name}")
            os.makedirs(wt_dir, exist_ok=True)
            d = self.load_descriptors[i]
            chunks = self.get_load_chunks(i)
            for c, chunk in enumerate(chunks):
                out_path = os.path.join(wt_dir, f"chunk{c:02d}.wav")
                with wave.open(out_path, 'wb') as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(d['sample_rate'])
                    wf.writeframes(struct.pack('<' + 'h' * len(chunk), *chunk))
            total += len(chunks)
        print(f"Saved {total} load chunks (64 wavetables × 16 chunks) to {out_dir}/")

    def extract_raw(self, index, out_dir):
        """Extract single wavetable as raw int16 binary file"""
        os.makedirs(out_dir, exist_ok=True)
        d = self.load_descriptors[index]
        samples = self.get_wavetable_samples(index)
        out_path = os.path.join(out_dir, f"{index:02d}_{self.names[index]}.raw")
        with open(out_path, 'wb') as f:
            f.write(struct.pack('<' + 'h' * len(samples), *samples))
        print(f"Saved: {out_path}")

    def extract_all_raw(self, out_dir):
        """Extract all as raw binary files"""
        for i in range(64):
            self.extract_raw(i, out_dir)

    def load_wav(self, wav_path):
        """Load WAV file, return (samples_list, sample_rate)"""
        with wave.open(wav_path, 'rb') as wf:
            if wf.getnchannels() != 1:
                raise ValueError("Only mono supported")
            if wf.getsampwidth() != 2:
                raise ValueError("Only 16-bit supported")
            sr = wf.getframerate()
            frames = wf.readframes(wf.getnframes())
            samples = struct.unpack('<' + 'h' * wf.getnframes(), frames)
        return list(samples), sr

    def load_wav_to_frame(self, wav_path, target_samples=2048):
        """
        Load WAV file and convert to exactly target_samples (default 2048 for one frame).
        - Mixes stereo to mono
        - Converts to 16-bit if needed
        - Resamples to target_samples if needed
        Returns (samples_list, original_sample_rate)
        """
        with wave.open(wav_path, 'rb') as wf:
            nchannels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            sr = wf.getframerate()
            nframes = wf.getnframes()
            frames = wf.readframes(nframes)

            if sampwidth == 1:
                # 8-bit unsigned to 16-bit signed
                samples = struct.unpack('<' + 'B' * nframes * nchannels, frames)
                samples = [(s - 128) * 256 for s in samples]
            elif sampwidth == 2:
                samples = struct.unpack('<' + 'h' * nframes * nchannels, frames)
            elif sampwidth == 3:
                # 24-bit - read as bytes and convert
                raw = list(frames)
                samples = []
                for i in range(0, len(raw), 3):
                    if i + 2 < len(raw):
                        # Little-endian 24-bit to 16-bit
                        val = raw[i] | (raw[i+1] << 8) | (raw[i+2] << 16)
                        if val & 0x800000:
                            val -= 0x1000000
                        samples.append(val >> 8)
            elif sampwidth == 4:
                samples = struct.unpack('<' + 'i' * nframes * nchannels, frames)
                # Convert 32-bit to 16-bit
                samples = [int(s / 65536) for s in samples]
            else:
                raise ValueError(f"Unsupported sample width: {sampwidth}")

            # Mix stereo to mono if needed
            if nchannels == 2:
                mono_samples = []
                for i in range(0, len(samples), 2):
                    if i + 1 < len(samples):
                        mono_samples.append((samples[i] + samples[i+1]) // 2)
                    else:
                        mono_samples.append(samples[i])
                samples = mono_samples
            elif nchannels > 2:
                # Mix all channels to mono
                mono_samples = []
                for i in range(0, len(samples), nchannels):
                    chunk = samples[i:i+nchannels]
                    mono_samples.append(sum(chunk) // len(chunk))
                samples = mono_samples

            # Resample to target_samples using simple linear interpolation
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

    def update_frame(self, wavetable_index, frame_index, new_frame_samples):
        """
        Update a single hardware frame (0-255) in a wavetable.
        Does not modify WTFT metadata.
        """
        if wavetable_index < 0 or wavetable_index >= 64:
            raise ValueError("Wavetable index must be 0-63")
        if frame_index < 0 or frame_index >= 256:
            raise ValueError("Frame index must be 0-255")

        d = self.load_descriptors[wavetable_index]
        frame_len = d['frame_len']  # 2048

        if len(new_frame_samples) != frame_len:
            raise ValueError(f"Expected {frame_len} samples for frame, got {len(new_frame_samples)}")

        # Calculate the offset in the file for this frame
        offset = self.offsets[wavetable_index]
        start = self.sample_start + offset + frame_index * frame_len * 2  # *2 for bytes
        new_bytes = struct.pack('<' + 'h' * frame_len, *new_frame_samples)
        self.data[start:start + frame_len * 2] = new_bytes

    def update_wavetable(self, index, new_samples, new_name=None, new_sr=None):
        """Update wavetable in memory (on SD card layout)"""
        if index < 0 or index >= 64:
            raise ValueError("Index 0-63")

        d = self.load_descriptors[index]
        expected_len = d['ram_size'] // 2
        if len(new_samples) != expected_len:
            raise ValueError(f"Expected {expected_len} samples, got {len(new_samples)}")

        # Update sample data on SD
        offset = self.offsets[index]
        start = self.sample_start + offset
        new_bytes = struct.pack('<' + 'h' * len(new_samples), *new_samples)
        self.data[start:start + d['ram_size']] = new_bytes

        # Update name in WTLS
        if new_name:
            self._update_name(index, new_name)
            self.names[index] = new_name

        # Update sample rate in WTLS
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
                    name_bytes = new_name.encode('ascii') + b'\x00'
                    name_len = min(len(name_bytes), 12)
                    new_wtnm = struct.pack('<III', 0, 1, name_len) + name_bytes.ljust(12, b'\x00')[:12] + b'WTFT$\x00\x00\x00'
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

    def save(self, path):
        with open(path, 'wb') as f:
            f.write(self.data)
        print(f"Saved to {path}")


def generate_sine_wavetable(sample_rate=44100, load_chunks=16, chunk_size=65536):
    """Generate a sine wavetable with evolving harmonics across 16 load chunks.
    Returns exactly load_chunks * (chunk_size//2) samples (524288 for defaults)."""
    import math
    total_samples = load_chunks * (chunk_size // 2)
    samples = [0] * total_samples

    samples_per_chunk = chunk_size // 2  # 32768
    f0 = sample_rate / samples_per_chunk  # fundamental frequency per chunk

    for c in range(load_chunks):
        chunk_start = c * samples_per_chunk
        # Harmonic evolution: more harmonics in early chunks, fewer in later
        for h in range(1, 8):
            amp = (1.0 / h) * (1.0 - c / load_chunks * 0.7)  # Decay higher harmonics
            for i in range(samples_per_chunk):
                t = i / sample_rate
                samples[chunk_start + i] += amp * math.sin(2 * math.pi * h * f0 * t)

    # Normalize to int16 range
    max_val = max(abs(s) for s in samples)
    if max_val > 0:
        scale = 32767 / max_val
        samples = [int(s * scale) for s in samples]

    return samples


def main():
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python3 cydrums_simple.py SystemCore.bin --list")
        print("  python3 cydrums_simple.py SystemCore.bin --extract-wav out_dir")
        print("  python3 cydrums_simple.py SystemCore.bin --extract-frames out_dir")
        print("  python3 cydrums_simple.py SystemCore.bin --extract-chunks out_dir")
        print("  python3 cydrums_simple.py SystemCore.bin --extract-raw out_dir")
        print("  python3 cydrums_simple.py SystemCore.bin --generate-sine --index 0 --output SystemCore_new.bin")
        print("  python3 cydrums_simple.py SystemCore.bin --update-wav 0 input.wav --name NewName --output SystemCore_new.bin [--sample-rate 24000|44100|384000]")
        print("  python3 cydrums_simple.py SystemCore.bin --update-frame 0 5 input.wav --output SystemCore_new.bin")
        return

    bin_file = sys.argv[1]
    extractor = SimpleWavetableExtractor(bin_file)

    if '--list' in sys.argv:
        extractor.list_wavetables()

    if '--extract-wav' in sys.argv:
        idx = sys.argv.index('--extract-wav')
        if idx + 1 < len(sys.argv):
            extractor.extract_all_wav(sys.argv[idx + 1])

    if '--extract-frames' in sys.argv:
        idx = sys.argv.index('--extract-frames')
        if idx + 1 < len(sys.argv):
            extractor.extract_all_frames(sys.argv[idx + 1])

    if '--extract-chunks' in sys.argv:
        idx = sys.argv.index('--extract-chunks')
        if idx + 1 < len(sys.argv):
            extractor.extract_all_load_chunks(sys.argv[idx + 1])

    if '--extract-raw' in sys.argv:
        idx = sys.argv.index('--extract-raw')
        if idx + 1 < len(sys.argv):
            extractor.extract_all_raw(sys.argv[idx + 1])

    if '--info' in sys.argv:
        idx = sys.argv.index('--info')
        if idx + 1 < len(sys.argv):
            target = int(sys.argv[idx + 1])
            d = extractor.load_descriptors[target]
            print(f"Wavetable {target}: {extractor.names[target]}")
            print(f"  Sample Rate (playback): {d['sample_rate']} Hz")
            print(f"  SD Load Chunks: {d['load_chunks']} × {d['chunk_size']} bytes")
            print(f"  RAM Size: {d['ram_size']} bytes ({d['ram_size']//2} samples)")
            print(f"  Hardware Frames in RAM: {d['num_frames']} × {d['frame_len']} samples")
            print(f"  Frames per Chunk: {d['frames_per_chunk']}")
            print(f"  Data Offset on SD: 0x{extractor.offsets[target]:08x}")
            info = extractor.analyze_waveform_cycles(target)
            print(f"  Acoustic Cycles: {info['acoustic_cycles']} ({info['samples_per_acoustic_cycle']:.1f} samples/cycle)")
            print(f"  Acoustic Cycles/Frame: {info['acoustic_cycles_per_frame']:.1f}")
            print(f"  Acoustic Cycles/Chunk: {info['acoustic_cycles_per_chunk']:.1f}")

    if '--generate-sine' in sys.argv:
        idx = sys.argv.index('--generate-sine')
        target_index = 0
        if '--index' in sys.argv:
            i_idx = sys.argv.index('--index')
            target_index = int(sys.argv[i_idx + 1])
        output_file = 'SystemCore_modified.bin'
        if '--output' in sys.argv:
            o_idx = sys.argv.index('--output')
            output_file = sys.argv[o_idx + 1]

        d = extractor.load_descriptors[target_index]
        print(f"Generating sine wavetable for index {target_index} ({extractor.names[target_index]})")
        print(f"  Sample rate: {d['sample_rate']}, Load chunks: {d['load_chunks']}, Chunk size: {d['chunk_size']}")
        print(f"  RAM frames: {d['num_frames']} × {d['frame_len']} samples")

        samples = generate_sine_wavetable(d['sample_rate'], d['load_chunks'], d['chunk_size'])
        extractor.update_wavetable(target_index, samples, new_name="SineEvolve")
        extractor.save(output_file)

    if '--update-wav' in sys.argv:
        idx = sys.argv.index('--update-wav')
        if idx + 1 < len(sys.argv):
            target_index = int(sys.argv[idx + 1])
            wav_file = None
            if '--wav' in sys.argv:
                w_idx = sys.argv.index('--wav')
                wav_file = sys.argv[w_idx + 1]
            new_name = None
            if '--name' in sys.argv:
                n_idx = sys.argv.index('--name')
                new_name = sys.argv[n_idx + 1]
            output_file = 'SystemCore_modified.bin'
            if '--output' in sys.argv:
                o_idx = sys.argv.index('--output')
                output_file = sys.argv[o_idx + 1]

            # Parse optional --sample-rate argument
            new_sr = None
            if '--sample-rate' in sys.argv:
                sr_idx = sys.argv.index('--sample-rate')
                if sr_idx + 1 < len(sys.argv):
                    try:
                        new_sr = int(sys.argv[sr_idx + 1])
                        if new_sr not in (24000, 44100, 384000):
                            print(f"Error: --sample-rate must be one of: 24000, 44100, 384000 (got {new_sr})")
                            return
                    except ValueError:
                        print(f"Error: --sample-rate must be an integer")
                        return

            if wav_file:
                print(f"Loading {wav_file}...")
                samples, file_sr = extractor.load_wav(wav_file)
                d = extractor.load_descriptors[target_index]

                # Resize to match expected length (524288 samples)
                expected = d['ram_size'] // 2
                if len(samples) < expected:
                    samples = samples + [0] * (expected - len(samples))
                elif len(samples) > expected:
                    samples = samples[:expected]

                # Use provided sample rate or fall back to WAV file's sample rate
                sr_to_use = new_sr if new_sr else file_sr
                print(f"Updating wavetable {target_index} ({extractor.names[target_index]})")
                print(f"  Sample rate: {sr_to_use} Hz" + (" (from --sample-rate)" if new_sr else f" (from WAV file)"))
                extractor.update_wavetable(target_index, samples, new_name=new_name, new_sr=sr_to_use)
                extractor.save(output_file)
            else:
                print("Error: --wav required for --update-wav")

    if '--update-frame' in sys.argv:
        idx = sys.argv.index('--update-frame')
        if idx + 2 < len(sys.argv):
            wavetable_index = int(sys.argv[idx + 1])
            frame_index = int(sys.argv[idx + 2])
            wav_file = None
            if '--wav' in sys.argv:
                w_idx = sys.argv.index('--wav')
                wav_file = sys.argv[w_idx + 1]
            output_file = 'SystemCore_modified.bin'
            if '--output' in sys.argv:
                o_idx = sys.argv.index('--output')
                output_file = sys.argv[o_idx + 1]

            if wav_file:
                print(f"Loading {wav_file} for wavetable {wavetable_index}, frame {frame_index}...")
                samples, file_sr = extractor.load_wav_to_frame(wav_file, target_samples=2048)
                print(f"  Converted to 2048 samples (original rate: {file_sr} Hz)")
                extractor.update_frame(wavetable_index, frame_index, samples)
                extractor.save(output_file)
                print(f"  Updated frame {frame_index} of wavetable {wavetable_index} ({extractor.names[wavetable_index]})")
            else:
                print("Error: --wav required for --update-frame")


if __name__ == '__main__':
    main()