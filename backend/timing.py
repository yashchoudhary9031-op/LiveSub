"""
timing.py - Video timeline mapping helpers for LiveSub.

Audio chunk seconds do not correspond 1:1 to video timeline seconds when
video playback rate is non-standard (e.g., 1.5x, 2.0x, 0.75x).
"""


def to_video_time(chunk_start: float, offset_in_chunk: float, rate: float = 1.0) -> float:
    """
    Convert an offset within an audio chunk (in audio seconds) to video timeline seconds,
    accounting for video playback rate.

    Formula:
        video_time = chunk_start + (offset_in_chunk * rate)
    
    Result is rounded to 2 decimal places.

    Example:
        chunk_start=12.4, offset_in_chunk=2.0, rate=1.5
        -> 12.4 + 2.0 * 1.5 = 15.4
    """
    return round(float(chunk_start) + float(offset_in_chunk) * float(rate), 2)
