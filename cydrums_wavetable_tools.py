#!/usr/bin/env python3
"""
CyDrums SystemCore.bin Wavetable Analysis and Extraction Tool

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
- Hardware addresses 0-127 map directly to 128 frames × 4096 samples in RAM
- Total sample data on SD: 64 MB
"""

import struct
import os
import wave
import numpy as np
from pathlib import Path
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass

@dataclass
class WavetableInfo:
    index: int
    name: str
    sample_rate: int
    load_chunks: int           # 16 - number of SD load chunks
    chunk_size: int            # 65536 bytes = 64KB per chunk
    ram_size: int              # 1048576 bytes = 1MB RAM needed
    data_offset: int
    file_offset: int
    # Derived (RAM layout after loading):
    num_frames: int = 128      # Hardware frames (0-127)
    frame_len: int = 4096      # Samples per hardware frame
    frames_per_chunk: int = 8  # 32768 / 4096 = 8 frames per chunk
    samples_per_chunk: int = 32768  # chunk_size // 2

class CyDrumsWavetableExtractor:
    def __init__(self, bin_path: str):
        self.bin_path = bin_path
        with open(bin_path, 'rb') as f:
            self.data = f.read()
        self.wtls_data = None
        self.sample_start = 0
        self.wavetables: List[WavetableInfo] = []
        self._parse()

    def _parse(self):
        # Parse WTLS header
        if self.data[:4] != b'WTLS':
            raise ValueError("Not a valid SystemCore.bin file (missing WTLS header)")

        wtls_size = struct.unpack('<I', self.data[4:8])[0]
        self.wtls_data = self.data[8:8+wtls_size]
        self.sample_start = 8 + wtls_size  # 0x1cf0

        # Parse WTNM entries (64 names)
        names = []
        pos = 0
        while pos < len(self.wtls_data) - 8:
            tag = self.wtls_data[pos:pos+4]
            if tag == b'WTNM':
                size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                wtnm_data = self.wtls_data[pos+8:pos+8+size]
                unk1, unk2, name_len = struct.unpack('<III', wtnm_data[:12])
                name_bytes = wtnm_data[12:12+name_len]
                name = name_bytes.split(b'\x00')[0].decode('ascii', errors='ignore')
                names.append(name)
                pos += 8 + size
            else:
                pos += 1

        # Parse WTFT entries (64 load descriptors)
        load_descriptors = []
        pos = 0
        while pos < len(self.wtls_data) - 8:
            tag = self.wtls_data[pos:pos+4]
            if tag == b'WTFT':
                size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                wtft_data = self.wtls_data[pos+8:pos+8+size]
                if len(wtft_data) >= 28:
                    parsed = struct.unpack('<IIIIIII', wtft_data[:28])
                    # parsed: unk1, unk2, load_chunks, chunk_size, sample_rate, unk3, ram_size
                    load_descriptors.append({
                        'load_chunks': parsed[2],
                        'chunk_size': parsed[3],
                        'sample_rate': parsed[4],
                        'ram_size': parsed[6],
                    })
                pos += 8 + size
            else:
                pos += 1

        # Parse WTPL entries (64 playlist entries with offsets)
        offsets = []
        pos = 0
        while pos < len(self.wtls_data) - 8:
            tag = self.wtls_data[pos:pos+4]
            if tag == b'WTPL':
                size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                wtpl_data = self.wtls_data[pos+8:pos+8+size]
                parsed = struct.unpack('<IIIIIII', wtpl_data)
                # parsed[3] = data offset
                offsets.append(parsed[3])
                pos += 8 + size
            else:
                pos += 1

        # Combine into wavetable info
        for i in range(64):
            if i < len(names) and i < len(load_descriptors) and i < len(offsets):
                d = load_descriptors[i]
                offset = offsets[i]
                self.wavetables.append(WavetableInfo(
                    index=i,
                    name=names[i],
                    sample_rate=d['sample_rate'],
                    load_chunks=d['load_chunks'],
                    chunk_size=d['chunk_size'],
                    ram_size=d['ram_size'],
                    data_offset=offset,
                    file_offset=self.sample_start + offset
                ))

    def get_wavetable_data(self, index: int) -> np.ndarray:
        """Get raw int16 samples for a wavetable (524,288 samples = RAM layout)"""
        wt = self.wavetables[index]
        wt_data = self.data[wt.file_offset:wt.file_offset + wt.ram_size]
        samples = np.frombuffer(wt_data, dtype=np.int16)
        return samples

    def get_frames(self, index: int) -> List[np.ndarray]:
        """Split wavetable into 128 hardware frames (4096 samples each, addressed 0-127 in RAM)"""
        samples = self.get_wavetable_data(index)
        wt = self.wavetables[index]
        frames = []
        for f in range(wt.num_frames):
            start = f * wt.frame_len
            end = start + wt.frame_len
            if end <= len(samples):
                frames.append(samples[start:end].copy())
        return frames

    def get_frame(self, index: int, frame_idx: int) -> np.ndarray:
        """Get a single hardware frame (0-127) from RAM layout"""
        if frame_idx < 0 or frame_idx >= 128:
            raise ValueError("Frame index must be 0-127")
        frames = self.get_frames(index)
        return frames[frame_idx]

    def get_load_chunks(self, index: int) -> List[np.ndarray]:
        """Split wavetable into 16 SD load chunks (32768 samples each = 8 hardware frames)"""
        samples = self.get_wavetable_data(index)
        wt = self.wavetables[index]
        chunk_len_samples = wt.samples_per_chunk  # 32768 samples
        chunks = []
        for c in range(wt.load_chunks):
            start = c * chunk_len_samples
            end = start + chunk_len_samples
            if end <= len(samples):
                chunks.append(samples[start:end].copy())
        return chunks

    def get_load_chunk(self, index: int, chunk_idx: int) -> np.ndarray:
        """Get a single SD load chunk (0-15)"""
        if chunk_idx < 0 or chunk_idx >= 16:
            raise ValueError("Load chunk index must be 0-15")
        chunks = self.get_load_chunks(index)
        return chunks[chunk_idx]

    def analyze_acoustic_cycles(self, index: int) -> Dict:
        """Analyze actual acoustic waveform cycles in the wavetable (RAM layout)"""
        samples = self.get_wavetable_data(index)
        wt = self.wavetables[index]

        # Count zero crossings
        pos_zc = int(np.sum((samples[:-1] <= 0) & (samples[1:] > 0)))
        neg_zc = int(np.sum((samples[:-1] >= 0) & (samples[1:] < 0)))
        total_zc = pos_zc + neg_zc
        acoustic_cycles = total_zc // 2
        samples_per_cycle = len(samples) / acoustic_cycles if acoustic_cycles > 0 else 0

        return {
            'acoustic_cycles': acoustic_cycles,
            'samples_per_acoustic_cycle': samples_per_cycle,
            'hardware_frames': wt.num_frames,
            'samples_per_frame': wt.frame_len,
            'load_chunks': wt.load_chunks,
            'samples_per_chunk': wt.samples_per_chunk,
            'acoustic_cycles_per_frame': acoustic_cycles / wt.num_frames,
            'acoustic_cycles_per_chunk': acoustic_cycles / wt.load_chunks,
        }

    def extract_wavetable_raw(self, index: int, output_dir: str):
        """Extract wavetable as raw int16 binary file"""
        wt = self.wavetables[index]
        samples = self.get_wavetable_data(index)
        os.makedirs(output_dir, exist_ok=True)
        out_path = os.path.join(output_dir, f"{wt.index:02d}_{wt.name}.raw")
        samples.tofile(out_path)
        print(f"Extracted {wt.name} to {out_path} ({len(samples)} samples)")
        return out_path

    def extract_wavetable_wav(self, index: int, output_dir: str,
                               separate_frames: bool = False,
                               separate_chunks: bool = False):
        """Extract wavetable as WAV file(s)"""
        wt = self.wavetables[index]
        os.makedirs(output_dir, exist_ok=True)

        if separate_frames:
            frames = self.get_frames(index)
            for f, frame in enumerate(frames):
                out_path = os.path.join(output_dir, f"{wt.index:02d}_{wt.name}_frame{f:03d}.wav")
                self._write_wav(out_path, frame, wt.sample_rate)
            print(f"Extracted {wt.name} as {len(frames)} hardware frames to {output_dir}")
        elif separate_chunks:
            chunks = self.get_load_chunks(index)
            for c, chunk in enumerate(chunks):
                out_path = os.path.join(output_dir, f"{wt.index:02d}_{wt.name}_chunk{c:02d}.wav")
                self._write_wav(out_path, chunk, wt.sample_rate)
            print(f"Extracted {wt.name} as {len(chunks)} load chunks to {output_dir}")
        else:
            samples = self.get_wavetable_data(index)
            out_path = os.path.join(output_dir, f"{wt.index:02d}_{wt.name}.wav")
            self._write_wav(out_path, samples, wt.sample_rate)
            print(f"Extracted {wt.name} to {out_path} ({len(samples)} samples)")
        return output_dir

    def _write_wav(self, path: str, samples: np.ndarray, sample_rate: int):
        """Write int16 samples as WAV file"""
        with wave.open(path, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(samples.astype(np.int16).tobytes())

    def extract_all_raw(self, output_dir: str):
        """Extract all 64 wavetables as raw files"""
        os.makedirs(output_dir, exist_ok=True)
        for wt in self.wavetables:
            self.extract_wavetable_raw(wt.index, output_dir)

    def extract_all_wav(self, output_dir: str, separate_frames: bool = False, separate_chunks: bool = False):
        """Extract all 64 wavetables as WAV files"""
        os.makedirs(output_dir, exist_ok=True)
        for wt in self.wavetables:
            self.extract_wavetable_wav(wt.index, output_dir, separate_frames, separate_chunks)

    def list_wavetables(self):
        """Print summary of all wavetables"""
        print(f"{'Idx':>3} {'Name':12s} {'SampleRate':>10} {'Chunks':>6} {'ChunkSize':>9} {'RAM Size':>8} {'Frames':>6} {'Offset':>10}")
        print("-" * 80)
        for wt in self.wavetables:
            print(f"{wt.index:3d} {wt.name:12s} {wt.sample_rate:10d} {wt.load_chunks:6d} {wt.chunk_size:9d} {wt.ram_size:8d} {wt.num_frames:6d} 0x{wt.data_offset:08x}")

    def create_wavetable_from_wav(self, wav_path: str, name: str,
                                   sample_rate: int = 44100,
                                   load_chunks: int = 16) -> Tuple[np.ndarray, Dict]:
        """Create wavetable data from a WAV file"""
        with wave.open(wav_path, 'rb') as wf:
            if wf.getnchannels() != 1:
                raise ValueError("Only mono WAV files supported")
            if wf.getsampwidth() != 2:
                raise ValueError("Only 16-bit WAV files supported")
            sr = wf.getframerate()
            frames = wf.readframes(wf.getnframes())
            samples = np.frombuffer(frames, dtype=np.int16)

        # Resample if needed
        if sr != sample_rate:
            from scipy import signal
            samples = signal.resample(samples, int(len(samples) * sample_rate / sr))
            samples = samples.astype(np.int16)

        # Ensure we have exactly load_chunks * samples_per_chunk samples
        samples_per_chunk = 32768  # Standard chunk size (samples)
        total_needed = load_chunks * samples_per_chunk

        if len(samples) < total_needed:
            # Pad with zeros
            samples = np.pad(samples, (0, total_needed - len(samples)), mode='constant')
        elif len(samples) > total_needed:
            # Truncate
            samples = samples[:total_needed]

        # Verify it divides evenly into chunks
        if len(samples) % samples_per_chunk != 0:
            raise ValueError(f"Sample count {len(samples)} not divisible by chunk size {samples_per_chunk}")

        actual_chunks = len(samples) // samples_per_chunk

        metadata = {
            'name': name,
            'sample_rate': sample_rate,
            'load_chunks': actual_chunks,
            'chunk_size': samples_per_chunk * 2,  # bytes
            'ram_size': len(samples) * 2,  # bytes
        }

        return samples, metadata

    def update_wavetable(self, index: int, new_samples: np.ndarray,
                         new_name: Optional[str] = None,
                         new_sample_rate: Optional[int] = None):
        """Update a wavetable in memory (call save() to write to disk)"""
        if index < 0 or index >= 64:
            raise ValueError("Index must be 0-63")

        wt = self.wavetables[index]
        if len(new_samples) != wt.ram_size // 2:
            raise ValueError(f"Expected {wt.ram_size//2} samples, got {len(new_samples)}")

        # Update sample data on SD
        start = wt.file_offset
        end = start + wt.ram_size
        self.data = self.data[:start] + new_samples.astype(np.int16).tobytes() + self.data[end:]

        # Update name if provided
        if new_name is not None:
            self._update_wtnm_name(index, new_name)
            wt.name = new_name

        # Update sample rate if provided
        if new_sample_rate is not None:
            self._update_wtft_sample_rate(index, new_sample_rate)
            wt.sample_rate = new_sample_rate

    def _update_wtnm_name(self, index: int, new_name: str):
        """Update WTNM name in WTLS data"""
        pos = 0
        count = 0
        while pos < len(self.wtls_data) - 8:
            tag = self.wtls_data[pos:pos+4]
            if tag == b'WTNM':
                if count == index:
                    size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                    wtnm_start = pos + 8
                    name_bytes = new_name.encode('ascii') + b'\x00'
                    name_len = len(name_bytes)
                    if name_len > 12:
                        name_len = 12
                        name_bytes = name_bytes[:12]

                    new_wtnm = struct.pack('<III', 0, 1, name_len) + name_bytes.ljust(12, b'\x00') + b'WTFT$' + b'\x00\x00\x00'
                    self.wtls_data = self.wtls_data[:wtnm_start] + new_wtnm + self.wtls_data[wtnm_start+size:]
                    wtls_start = 8
                    self.data = self.data[:wtls_start] + self.wtls_data + self.data[wtls_start+len(self.wtls_data):]
                    return
                count += 1
                size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                pos += 8 + size
            else:
                pos += 1

    def _update_wtft_sample_rate(self, index: int, new_sample_rate: int):
        """Update WTFT sample rate in WTLS data"""
        pos = 0
        count = 0
        while pos < len(self.wtls_data) - 8:
            tag = self.wtls_data[pos:pos+4]
            if tag == b'WTFT':
                if count == index:
                    size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                    wtft_start = pos + 8
                    wtft_data = bytearray(self.wtls_data[wtft_start:wtft_start+size])
                    struct.pack_into('<I', wtft_data, 16, new_sample_rate)
                    self.wtls_data = self.wtls_data[:wtft_start] + bytes(wtft_data) + self.wtls_data[wtft_start+size:]
                    wtls_start = 8
                    self.data = self.data[:wtls_start] + self.wtls_data + self.data[wtls_start+len(self.wtls_data):]
                    return
                count += 1
                size = struct.unpack('<I', self.wtls_data[pos+4:pos+8])[0]
                pos += 8 + size
            else:
                pos += 1

    def save(self, output_path: str):
        """Save modified SystemCore.bin"""
        with open(output_path, 'wb') as f:
            f.write(self.data)
        print(f"Saved to {output_path}")

    def create_new_systemcore(self, output_path: str, wavetables: List[Tuple[str, np.ndarray, int]]):
        """
        Create a new SystemCore.bin from scratch
        wavetables: list of (name, samples, sample_rate) tuples
        """
        raise NotImplementedError("Use update_wavetable() and save() instead")


def main():
    import argparse

    parser = argparse.ArgumentParser(description='CyDrums SystemCore.bin Wavetable Tool')
    parser.add_argument('bin_file', help='Path to SystemCore.bin')
    parser.add_argument('--list', action='store_true', help='List all wavetables')
    parser.add_argument('--extract-raw', metavar='DIR', help='Extract all as raw files')
    parser.add_argument('--extract-wav', metavar='DIR', help='Extract all as WAV files')
    parser.add_argument('--extract-frames', metavar='DIR', help='Extract all hardware frames (128 per wavetable) as WAVs')
    parser.add_argument('--extract-chunks', metavar='DIR', help='Extract all load chunks (16 per wavetable) as WAVs')
    parser.add_argument('--info', type=int, help='Show detailed info for wavetable index')
    parser.add_argument('--update', type=int, help='Update wavetable index with WAV file')
    parser.add_argument('--wav', help='WAV file for update')
    parser.add_argument('--name', help='New name for update')
    parser.add_argument('--output', help='Output file for save')

    args = parser.parse_args()

    extractor = CyDrumsWavetableExtractor(args.bin_file)

    if args.list:
        extractor.list_wavetables()

    if args.extract_raw:
        extractor.extract_all_raw(args.extract_raw)

    if args.extract_wav:
        extractor.extract_all_wav(args.extract_wav, separate_frames=False, separate_chunks=False)

    if args.extract_frames:
        extractor.extract_all_wav(args.extract_frames, separate_frames=True, separate_chunks=False)

    if args.extract_chunks:
        extractor.extract_all_wav(args.extract_chunks, separate_frames=False, separate_chunks=True)

    if args.info is not None:
        wt = extractor.wavetables[args.info]
        print(f"Wavetable {wt.index}: {wt.name}")
        print(f"  Sample Rate (playback): {wt.sample_rate} Hz")
        print(f"  SD Load Chunks: {wt.load_chunks} × {wt.chunk_size} bytes")
        print(f"  RAM Size: {wt.ram_size} bytes ({wt.ram_size//2} samples)")
        print(f"  Hardware Frames in RAM: {wt.num_frames} × {wt.frame_len} samples")
        print(f"  Frames per Chunk: {wt.frames_per_chunk}")
        print(f"  Data Offset on SD: 0x{wt.data_offset:08x}")
        print(f"  File Offset: 0x{wt.file_offset:08x}")

        # Show acoustic cycle info
        info = extractor.analyze_acoustic_cycles(args.info)
        print(f"  Acoustic Cycles: {info['acoustic_cycles']} ({info['samples_per_acoustic_cycle']:.1f} samples/cycle)")
        print(f"  Acoustic Cycles/Frame: {info['acoustic_cycles_per_frame']:.1f}")
        print(f"  Acoustic Cycles/Chunk: {info['acoustic_cycles_per_chunk']:.1f}")

        # Show frame stats
        frames = extractor.get_frames(args.info)
        for f, frame in enumerate(frames):
            zc = int(np.sum((frame[:-1] <= 0) & (frame[1:] > 0)) + np.sum((frame[:-1] >= 0) & (frame[1:] < 0)))
            print(f"  Frame {f:3d}: min={frame.min():6d}, max={frame.max():6d}, mean={frame.mean():7.1f}, zc={zc}")

    if args.update is not None and args.wav:
        samples, metadata = extractor.create_wavetable_from_wav(
            args.wav,
            args.name or extractor.wavetables[args.update].name,
            sample_rate=extractor.wavetables[args.update].sample_rate
        )
        extractor.update_wavetable(args.update, samples,
                                    new_name=args.name,
                                    new_sample_rate=metadata['sample_rate'])
        if args.output:
            extractor.save(args.output)
        else:
            print("Use --output to save changes")


if __name__ == '__main__':
    main()