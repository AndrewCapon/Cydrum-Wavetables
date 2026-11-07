# CyDrums SystemCore.bin Wavetable Format Documentation

NOTE: Do not use, this is work in progress.

## Overview

The `SystemCore.bin` file contains 64 wavetables for the CyDrums Drum Synth. Each wavetable consists of **256 hardware frames** (2,048 samples each) at varying sample rates, stored as 16-bit signed integers (little-endian). The WTFT metadata describes an **SD Card → RAM Load Descriptor**: 16 load chunks of 65,536 bytes each = 1 MB RAM loaded from SD card, then played from RAM by hardware.

## File Structure

```
SystemCore.bin
├── WTLS Header (8 bytes + 7,400 bytes data)
│   ├── "WTLS" tag (4 bytes)
│   ├── Size: 0x1CE8 (7,400 bytes) (4 bytes)
│   └── Data (7,400 bytes):
│       ├── 64 × WTNM chunks (name entries)
│       ├── 64 × WTFT chunks (format metadata - RAM load descriptors)
│       └── 64 × WTPL chunks (playlist/offset entries)
├── Sample Data (64 MB = 64 × 1,048,576 bytes)
│   └── 64 wavetables × 1 MB each (524,288 int16 samples = 256 frames × 2,048 samples)
└── Padding (0xFFFFFFFF fill to file end)
```

## Chunk Format

All chunks follow the same structure:
```
Tag (4 bytes) | Size (4 bytes, little-endian) | Data (Size bytes)
```

### Chunk Types

| Tag | Name | Count | Purpose |
|-----|------|-------|---------|
| `WTLS` | Wavetable List | 1 | Root container |
| `WTNM` | Wavetable Name | 64 | Name + padding + next chunk preview |
| `WTFT` | Wavetable Flash Transfer | 64 | RAM load descriptor (SD→RAM) |
| `WTPL` | Wavetable Playlist | 64 | Offset into sample data on SD |
| `WTDT` | Wavetable Data Table | 32 | Nested name + load descriptor + playlist (subset) |

## WTLS Header

At file offset 0:
- `WTLS` tag
- Size: 0x1CE8 (7,400 bytes)
- Contains all metadata chunks

## WTNM - Wavetable Name (32 bytes typical)

```
Offset 0:  unk1 (uint32) = 0
Offset 4:  unk2 (uint32) = 1
Offset 8:  name_len (uint32) = 8 or 12
Offset 12: name (ASCII, null-terminated, padded to name_len)
Offset 12+name_len: padding (0xFF 0xFF 0xFF)
Offset 16+name_len: "WTFT$" + 3 null bytes (preview of next chunk)
```

**Names (64 total):**
```
0:  SinCrsh1    16: SawMoph1    32: TriForm1    48: Trnsfrm3
1:  SinCrsh2    17: SawMoph2    33: TriForm2    49: Trnsfrm4
2:  SinFold1    18: SawRand1    34: TriRand1    50: Trnsfrm5
3:  SinFold2    19: SawRand2    35: TriRand2    51: Trnsfrm6
4:  SinForml    20: SawRand3    36: TriRand3    52: RndGlitch
5:  SinMoph1    21: SawSpec1    37: TriShape    53: HarmGlitch
6:  SinMoph2    22: SawSpec2    38: TriSpec     54: SawGlitch
7:  SinRand1    23: SqrFM       39: FMcrush1    55: SinDuty
8:  SinRand2    24: SqrForml    40: FMcrush2    56: SqrDuty
9:  SinRand3    25: SqrNoiz1    41: FoldCrsh    57: TriDuty
10: SinSpec1    26: SqrNoiz2    42: Harmonc1    58: SawDuty
11: SinSpec2    27: SqrRand1    43: Harmonc2    59: SmpSnare
12: SinSpec3    28: SqrRand2    44: HarmMoph    60: SmpCymbl
13: SinSpec4    29: SqrSpec1    45: Trnsfrm1    61: SmpCrsh
14: SawShape    30: SqrSpec2    46: Trnsfrm2    62: Sweep
15: SawCrush    31: TriForm1    47: Trnsfrm2    63: Noise1
                                                        64: Noise2
                                                        65: Noise3
```

## WTFT - Wavetable Flash Transfer (36 bytes)

```
Offset 0:  unk1 (uint32) = 0
Offset 4:  unk2 (uint32) = 1
Offset 8:  load_chunks (uint32) = 16
Offset 12: chunk_size (uint32) = 65536 (bytes = 32,768 samples = 64KB)
Offset 16: sample_rate (uint32) = 24000, 44100, or 384000
Offset 20: unk3 (uint32) = 0
Offset 24: ram_size (uint32) = 1048576 (bytes = 524,288 samples = 1MB)
Offset 28: "WTPL" + size preview
```

**Sample Rates:**
- 24,000 Hz: Most wavetables (48 of 64)
- 44,100 Hz: SinFold1, SawShape, SawMoph2, SqrRand2, TriShape, RndGlitch, HarmGlitch, SawGlitch, SinDuty, SqrDuty, TriDuty, SawDuty (12 of 64)
- 384,000 Hz: SmpSnare, SmpCymbl, SmpCrsh (3 of 64)

**Key Parameters (SD→RAM Load Descriptor):**
- `load_chunks` = 16 (number of 64KB chunks to load from SD to RAM)
- `chunk_size` = 65536 bytes (64KB per chunk)
- `sample_rate` = Playback rate after loading to RAM
- `ram_size` = 1,048,576 bytes (1 MB RAM needed after loading)
- 16 × 65536 = 1,048,576 ✓

## WTPL - Wavetable Playlist (28 bytes)

```
Offset 0:  unk1 (uint32) = 0
Offset 4:  unk2 (uint32) = 1
Offset 8:  unk3 (uint32) = 8
Offset 12: data_offset (uint32) = offset into sample data (0, 0x100000, 0x200000, ...)
Offset 16: unk4 (uint32) = 1048576
Offset 20: unk5 (uint32) = 1413764183 (0x54445457 = "WTDT" little-endian)
Offset 24: unk6 (uint32) = 116 (WTDT size)
```

**Data Offsets (relative to sample data start at 0x1E00):**
```
Wavetable 0:  0x00000000
Wavetable 1:  0x00100000
Wavetable 2:  0x00200000
...
Wavetable 63: 0x03F00000
```

Each wavetable is 1 MB (0x100000 bytes) apart.

## Sample Data

**Starts at file offset:** 0x1E00 (after WTLS header + 272 bytes / 136 samples of 0xFFFF padding)

**Format:** 16-bit signed integers (int16), little-endian

**Per Wavetable:**
- Size: 1,048,576 bytes = 524,288 samples
- **Hardware Frames:** 256 frames × 2,048 samples = 524,288 samples (addressed 0-255 in RAM)
- **SD Load Chunks:** 16 chunks × 32,768 samples = 524,288 samples (loaded sequentially from SD to RAM)
- **Frame size:** 2,048 samples (4,096 bytes)
- **Load chunk size:** 32,768 samples (65,536 bytes = 64KB = 16 hardware frames)
- Duration per hardware frame at 24kHz: 2048/24000 = 0.085 seconds
- Duration per hardware frame at 44.1kHz: 2048/44100 = 0.046 seconds
- Duration per hardware frame at 384kHz: 2048/384000 = 0.005 seconds
- Duration per load chunk at 24kHz: 32768/24000 = 1.365 seconds
- Duration per load chunk at 44.1kHz: 32768/44100 = 0.743 seconds
- Duration per load chunk at 384kHz: 32768/384000 = 0.085 seconds

**Total Sample Data:** 64 MB

### Three Distinct Concepts (Critical Distinction)

| Concept | Count | Size | Purpose |
|---------|-------|------|---------|
| **Hardware Frames** | 256 | 2,048 samples | Direct hardware addressing (0-255 in RAM) |
| **SD Load Chunks (WTFT)** | 16 | 32,768 samples | SD→RAM DMA transfer units (64KB each) |
| **Acoustic Waveform Cycles** | Varies (256 - 130,000+) | Varies | Actual waveform periods in the audio content |

**Relationship:**
- 1 SD load chunk = 16 hardware frames (32,768 / 2,048 = 16)
- 16 load chunks × 16 = 256 hardware frames
- Acoustic cycles vary per wavetable content

### Actual Acoustic Waveform Cycles (Content-Dependent)

The "16 load chunks" in WTFT metadata refers to **SD→RAM DMA transfer units**, not acoustic waveform periods. The actual number of acoustic cycles varies per wavetable:

| Wavetable Category | Acoustic Cycles | Samples/Cycle | Type |
|-------------------|-----------------|---------------|------|
| SinCrsh1/2, SinFold1, SinMoph1/2, SinRand1/2/3, SinSpec1-4 | 256 | 2,048 | Clean harmonic |
| SawShape | 754 | 695 | Sawtooth |
| SawCrush | 4,580 | 114 | Distorted |
| SawRand1/2/3, SqrRand1/2, TriRand1/2/3 | ~45k-75k | ~7-12 | Noise-like |
| SqrFM, SqrForml, SqrSpec1/2, TriForm1/2, TriShape, TriSpec | 256-1,300 | 400-2,000 | Synthesis |
| FMcrush1/2, FoldCrsh, Harmonc1/2, HarmMoph | 256-2,000 | 400-2,000 | Processed |
| Trnsfrm1-6 | ~1,800-5,000 | 100-300 | Transformed |
| RndGlitch, HarmGlitch, SawGlitch | ~1,800-2,000 | 270-290 | Glitch |
| SinDuty, SqrDuty, TriDuty, SawDuty | 256 | 2,048 | PWM |
| SmpSnare, SmpCymbl, SmpCrsh | ~58k-131k | 4-90 | Sampled |
| Sweep, Noise1-3 | ~9k-119k | 4-57 | Noise/sweep |

### Frame/Chunk Structure

```
Wavetable (524,288 samples = 256 hardware frames = 16 load chunks)
├── Load Chunk 0 (32,768 samples = 16 hardware frames) ──► SD DMA transfer #0
│   ├── Hardware Frame 0 (2,048 samples)
│   ├── Hardware Frame 1 (2,048 samples)
│   ├── Hardware Frame 2 (2,048 samples)
│   ├── Hardware Frame 3 (2,048 samples)
│   ├── Hardware Frame 4 (2,048 samples)
│   ├── Hardware Frame 5 (2,048 samples)
│   ├── Hardware Frame 6 (2,048 samples)
│   ├── Hardware Frame 7 (2,048 samples)
│   ├── Hardware Frame 8 (2,048 samples)
│   ├── Hardware Frame 9 (2,048 samples)
│   ├── Hardware Frame 10 (2,048 samples)
│   ├── Hardware Frame 11 (2,048 samples)
│   ├── Hardware Frame 12 (2,048 samples)
│   ├── Hardware Frame 13 (2,048 samples)
│   ├── Hardware Frame 14 (2,048 samples)
│   └── Hardware Frame 15 (2,048 samples)
├── Load Chunk 1 (32,768 samples = 16 hardware frames) ──► SD DMA transfer #1
│   ├── Hardware Frame 16
│   └── ... Hardware Frame 31
├── ...
└── Load Chunk 15 (32,768 samples = 16 hardware frames) ──► SD DMA transfer #15
    ├── Hardware Frame 240
    └── ... Hardware Frame 255
```

Each hardware frame contains many acoustic waveform cycles. The synth plays directly from RAM using hardware addresses 0-255. The 16 load chunks are only for SD→RAM transfer at boot/load time.

## WTDT - Nested Wavetable Data Table (32 entries)

A subset of 32 wavetables have nested WTDT chunks containing:
- Header: 3 uint32 (0, 3, 0)
- WTNM chunk (name)
- WTFT data (28 bytes, raw - no tag/size)
- WTPL data (28 bytes, raw - no tag/size)
- Trailer: 1 uint32 (1)

These appear to be a legacy/redundant structure referencing a subset of the 64 wavetables.

## Usage with Extraction Tool

### Installation

```bash
pip install numpy scipy --break-system-packages
```

### List All Wavetables

```bash
python3 cydrums_wavetable_tools.py SystemCore.bin --list
```

### Extract All as WAV Files (full wavetables)

```bash
python3 cydrums_wavetable_tools.py SystemCore.bin --extract-wav output_wavs/
```

### Extract All Hardware Frames (256 per wavetable)

```bash
python3 cydrums_wavetable_tools.py SystemCore.bin --extract-frames output_frames/
```

### Extract All SD Load Chunks (16 per wavetable)

```bash
python3 cydrums_wavetable_tools.py SystemCore.bin --extract-chunks output_chunks/
```

### Extract All as Raw Binary Files

```bash
python3 cydrums_wavetable_tools.py SystemCore.bin --extract-raw output_raw/
```

### Get Detailed Info for a Wavetable

```bash
python3 cydrums_wavetable_tools.py SystemCore.bin --info 0
```

### Update a Wavetable from WAV File

```bash
python3 cydrums_wavetable_tools.py SystemCore.bin \
  --update 0 \
  --wav new_wavetable.wav \
  --name "NewName" \
  --output SystemCore_modified.bin
```

## Creating Custom Wavetables

### Requirements

1. **Mono** WAV file
2. **16-bit** depth
3. Length should be multiple of 32,768 samples (16 load chunks × 32768 = 524,288 samples ideal)
4. Will be resampled to target sample rate if needed

### Programmatic Creation

```python
from cydrums_wavetable_tools import CyDrumsWavetableExtractor
import numpy as np

extractor = CyDrumsWavetableExtractor("SystemCore.bin")

# Create from WAV file
samples, metadata = extractor.create_wavetable_from_wav(
    "my_wavetable.wav",
    "MyWavetable",
    sample_rate=44100,
    load_chunks=16
)

# Update wavetable index 5
extractor.update_wavetable(5, samples, new_name="MyWavetable", new_sample_rate=44100)

# Save modified file
extractor.save("SystemCore_custom.bin")
```

### Generating Wavetables Programmatically

```python
import numpy as np

# Generate a simple sine wavetable with 16 load chunks
sample_rate = 44100
samples_per_chunk = 32768
load_chunks = 16

t = np.arange(samples_per_chunk * load_chunks)
# Fundamental frequency for one load chunk
f0 = sample_rate / samples_per_chunk

# Create 16 load chunks with evolving harmonics
samples = np.zeros(samples_per_chunk * load_chunks)
for c in range(load_chunks):
    chunk_start = c * samples_per_chunk
    chunk_end = chunk_start + samples_per_chunk
    # Add harmonics that change per load chunk
    for h in range(1, 5):
        amp = 1.0 / h * (1.0 - c / load_chunks * 0.5)  # Decay harmonics
        samples[chunk_start:chunk_end] += amp * np.sin(2 * np.pi * h * f0 * np.arange(samples_per_chunk))

# Normalize to int16 range
samples = np.clip(samples * 32767, -32768, 32767).astype(np.int16)

# Use with extractor
extractor.update_wavetable(0, samples, new_name="SineEvolve", new_sample_rate=sample_rate)
extractor.save("SystemCore_custom.bin")
```

### Accessing Individual Frames/Chunks

```python
# Get all 256 hardware frames (2048 samples each, addressed 0-255 in RAM)
frames = extractor.get_frames(0)  # List of 256 arrays

# Get single hardware frame (0-255)
frame_5 = extractor.get_frame(0, 5)

# Get all 16 SD load chunks (32768 samples each)
chunks = extractor.get_load_chunks(0)  # List of 16 arrays

# Get single SD load chunk (0-15)
chunk_3 = extractor.get_load_chunk(0, 3)
```

## File Format Summary for Developers

### Reading a Wavetable

```python
import struct

with open("SystemCore.bin", "rb") as f:
    data = f.read()

# Skip WTLS header (8 + 7400 = 0x1CF0, but actual sample data starts at 0x1E00)
sample_start = 0x1E00

# Wavetable index i is at:
offset = sample_start + i * 0x100000
wavetable_data = data[offset:offset + 0x100000]
samples = struct.unpack('<' + 'h' * 524288, wavetable_data)

# Get hardware frame f (0-255):
frame_start = f * 2048
frame = samples[frame_start:frame_start + 2048]

# Get SD load chunk c (0-15):
chunk_start = c * 32768
chunk = samples[chunk_start:chunk_start + 32768]
```

### Writing a Wavetable

```python
import struct

# Prepare new samples (must be exactly 524288 int16 values)
new_samples = ...  # your numpy array or list

# Convert to bytes
new_bytes = struct.pack('<' + 'h' * 524288, *new_samples)

# Write at correct offset
with open("SystemCore.bin", "r+b") as f:
    f.seek(0x1E00 + i * 0x100000)
    f.write(new_bytes)

# Also update WTFT sample rate if changed
wtft_offset = find_wtft_offset(i)  # parse WTLS
f.seek(wtft_offset + 16)
f.write(struct.pack('<I', new_sample_rate))

# Update WTNM name if changed
wtnm_offset = find_wtnm_offset(i)
f.seek(wtnm_offset + 12)
f.write(new_name.encode('ascii').ljust(12, b'\x00')[:12])
```

## Offset Reference

| Component | File Offset | Size |
|-----------|-------------|------|
| WTLS Header | 0x00000000 | 8 bytes |
| WTLS Data | 0x00000008 | 7,400 bytes |
| Sample Data Start | 0x00001E00 | - |
| Wavetable 0 | 0x00001E00 | 1,048,576 bytes |
| Wavetable 1 | 0x00101E00 | 1,048,576 bytes |
| ... | ... | ... |
| Wavetable 63 | 0x03F01E00 | 1,048,576 bytes |
| End of Samples | 0x04001E00 | - |
| Padding | 0x04001E00+ | to EOF |

## Notes

1. The WTFT `chunk_size` field is in **bytes** (65536), not samples (32768)
2. The first wavetable (SinCrsh1) appears to be mostly empty/silence
3. Some names are truncated in the nested WTDT chunks (only 32 WTDT entries exist)
4. The nested WTDT chunks appear to be a legacy/redundant structure
5. Padding between sample data and EOF is filled with 0xFFFFFFFF
6. **Hardware frames (256) are the native RAM addressing unit (0-255). SD Load chunks (16) are for DMA transfer from SD card to RAM at load time. They are related: 1 load chunk = 16 hardware frames = 64KB.**
7. The SD card is too slow for random access streaming; all data is loaded to RAM first.
8. Bit depth (16-bit) is an implicit format constant, not stored in the file.

## Credits

Analysis and tools by reverse engineering the SystemCore.bin format.