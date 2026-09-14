"""Short opaque id generator with type prefixes (b_/v_/a_/j_/u_/p_)."""

import secrets

_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
_LENGTH = 10

PREFIX_BATCH = "b_"
PREFIX_VIDEO = "v_"
PREFIX_ASSET = "a_"
PREFIX_JOB = "j_"
PREFIX_UPLOAD = "u_"
PREFIX_LAYER = "l_"
PREFIX_PRESET = "p_"


def new_id(prefix: str) -> str:
    return prefix + "".join(secrets.choice(_ALPHABET) for _ in range(_LENGTH))


def batch_id() -> str:
    return new_id(PREFIX_BATCH)


def video_id() -> str:
    return new_id(PREFIX_VIDEO)


def asset_id() -> str:
    return new_id(PREFIX_ASSET)


def job_id() -> str:
    return new_id(PREFIX_JOB)


def upload_id() -> str:
    return new_id(PREFIX_UPLOAD)


def preset_id() -> str:
    return new_id(PREFIX_PRESET)
