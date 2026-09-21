"""MiniMax 合成路径（HIG-59）与它顺带影响的 qwen3 / tts_v2 分支。

仓库里其他测试一律靠 ``LOCALIZE_PROVIDER=fake``（conftest）绕开 provider 层，所以在这个文件之前
``dashscope_providers`` 没有任何单元测试。这里不装假 HTTP，而是把整个 ``dashscope`` SDK 换成假模块
塞进 ``sys.modules``：provider 里每个 ``import dashscope`` 都在函数体内（文件头注释说明了原因），
所以这样注入就能拿到真实的调用参数，且永远不碰网络。
"""

from __future__ import annotations

import sys
import types
from typing import Any

import pytest

from app.services import dashscope_providers as dp
from app.services.localize import LocalizeError
from app.services.screentext import ScreenTextFrameParseError

MINIMAX_MODEL = "MiniMax/speech-2.8-hd"
WAV = b"RIFF\x00\x00\x00\x00WAVEfmt "


class Recorder:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.downloads: list[str] = []


def _response(output: Any, status: int = 200) -> Any:
    return types.SimpleNamespace(status_code=status, output=output, message="", code="")


@pytest.fixture
def fake_sdk(monkeypatch):
    """A stand-in ``dashscope`` package plus a no-sleep retry and a recorded ``urlopen``."""
    rec = Recorder()
    rec.results: list[Any] = []

    def call(**kwargs: Any) -> Any:
        rec.calls.append(kwargs)
        result = rec.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    base_api = types.ModuleType("dashscope.client.base_api")
    base_api.BaseApi = type("BaseApi", (), {"call": staticmethod(call)})
    client = types.ModuleType("dashscope.client")
    client.base_api = base_api
    dashscope = types.ModuleType("dashscope")
    dashscope.api_key = None
    dashscope.client = client
    dashscope.MultiModalConversation = type("MultiModalConversation", (), {"call": staticmethod(call)})
    monkeypatch.setitem(sys.modules, "dashscope", dashscope)
    monkeypatch.setitem(sys.modules, "dashscope.client", client)
    monkeypatch.setitem(sys.modules, "dashscope.client.base_api", base_api)
    monkeypatch.setattr(dp.time, "sleep", lambda *_: None)
    monkeypatch.setattr(dp, "_minimax_last_call", 0.0)  # the pacing gate is module state

    class Resp:
        def __init__(self, data: bytes) -> None:
            self._data = data

        def __enter__(self) -> Resp:
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def read(self) -> bytes:
            return self._data

    def urlopen(url: str, timeout: int = 0) -> Resp:  # noqa: ARG001
        rec.downloads.append(url)
        return Resp(WAV)

    monkeypatch.setattr(dp.urllib.request, "urlopen", urlopen)
    rec.dashscope = dashscope
    return rec


def _tts() -> dp.DashScopeTts:
    return dp.DashScopeTts(api_key="k", model="cosyvoice-v3-flash")


# --- 请求体（纯函数，不需要假 SDK）-------------------------------------------------


def test_minimax_input_nests_the_settings_the_vendor_wants():
    body = dp._minimax_input("你好", "Chinese (Mandarin)_Sweet_Lady", 1.2, "zh", "happy")
    assert body["text"] == "你好"
    assert body["voice_setting"] == {
        "voice_id": "Chinese (Mandarin)_Sweet_Lady",
        "speed": 1.2,
        "language_boost": "Chinese",
        "emotion": "happy",
    }
    # wav is not the vendor default (mp3); getting it wrong only surfaces later as "合成结果为空"
    assert body["audio_setting"] == {"format": "wav", "sample_rate": 22050, "channel": 1}
    assert body["output_format"] == "hex"
    # the console's curl sample for this model card carries both; the API reference page omits them
    assert body["action"] == "tts" and body["stream"] is False


def test_minimax_input_omits_emotion_and_clamps_speed():
    plain = dp._minimax_input("hi", "Thai_female_1_sample1", 1.0, "th", None)
    assert "emotion" not in plain["voice_setting"]
    assert plain["voice_setting"]["language_boost"] == "Thai"
    assert dp._minimax_input("x", "v", 3.0, None, None)["voice_setting"]["speed"] == 2.0
    assert dp._minimax_input("x", "v", 0.1, None, None)["voice_setting"]["speed"] == 0.5
    # an unlisted language falls back to the vendor's own auto-detection
    assert dp._minimax_input("x", "v", 1.0, "xx", None)["voice_setting"]["language_boost"] == "auto"


# --- 分发 -----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("model", "expected"),
    [(MINIMAX_MODEL, "minimax"), ("minimax/speech-02-turbo", "minimax"), ("qwen3-tts-flash", "qwen3"), ("cosyvoice-v3-flash", "tts_v2")],
)
def test_synthesize_dispatches_on_the_model_prefix(monkeypatch, model, expected):
    """Nothing outside the ``MiniMax/`` prefix changes route, and the model name goes down untouched."""
    seen: list[tuple[str, str]] = []
    # the model argument sits at a different position in each private method's signature
    for name, api, at in (("_synthesize_minimax", "minimax", 3), ("_synthesize_qwen3", "qwen3", 2), ("_synthesize_tts_v2", "tts_v2", 3)):

        def spy(self, *args: Any, _api: str = api, _at: int = at, **_: Any) -> bytes:  # noqa: ANN001, ARG001
            seen.append((_api, args[_at]))
            return WAV

        monkeypatch.setattr(dp.DashScopeTts, name, spy)
    assert _tts().synthesize("t", "v", model=model) == WAV
    assert seen == [(expected, model)]


# --- 响应 -----------------------------------------------------------------------


def test_minimax_decodes_hex_without_downloading_anything(fake_sdk):
    fake_sdk.results = [_response({"data": {"audio": WAV.hex()}, "base_resp": {"status_code": 0}})]
    assert _tts().synthesize("t", "v", 1.0, model=MINIMAX_MODEL, lang="th") == WAV
    assert fake_sdk.downloads == []
    sent = fake_sdk.calls[0]
    assert sent["model"] == MINIMAX_MODEL  # the vendor's own capitalization goes out untouched
    assert sent["task"] == "multimodal-generation" and sent["function"] == "generation"
    assert sent["input"]["voice_setting"]["voice_id"] == "v"


def test_minimax_downloads_when_the_answer_is_a_url(fake_sdk):
    fake_sdk.results = [_response({"data": {"audio": "https://example.test/a.wav"}})]
    assert _tts().synthesize("t", "v", 1.0, model=MINIMAX_MODEL) == WAV
    assert fake_sdk.downloads == ["https://example.test/a.wav"]


def test_minimax_accepts_base64_and_an_object_shaped_output(fake_sdk):
    import base64

    audio = types.SimpleNamespace(url=None, data=base64.b64encode(WAV).decode())
    fake_sdk.results = [_response(types.SimpleNamespace(data=types.SimpleNamespace(audio=audio), base_resp=None))]
    assert _tts().synthesize("t", "v", 1.0, model=MINIMAX_MODEL) == WAV


@pytest.mark.parametrize(
    ("output", "fragment"),
    [
        ({"data": {"audio": ""}}, "没有返回音频"),
        ({"request_id": "r"}, "没有返回音频"),
        ({"data": {"audio": "zz"}}, "无法解码"),
        ({"data": {"audio": b"ID3\x03".hex()}}, "不是 wav"),
        ({"base_resp": {"status_code": 1004, "status_msg": "invalid voice_id"}}, "invalid voice_id"),
    ],
)
def test_minimax_fails_loudly_on_a_shape_it_cannot_use(fake_sdk, output, fragment):
    fake_sdk.results = [_response(output)]
    with pytest.raises(LocalizeError) as exc:
        _tts().synthesize("t", "Thai_female_1_sample1", 1.0, model=MINIMAX_MODEL)
    # the voice id has to be in the message: GET /api/tts/preview hands it to the user as a 502
    assert fragment in str(exc.value) and "Thai_female_1_sample1" in str(exc.value)


# --- 重试 -----------------------------------------------------------------------


def test_minimax_retries_a_429_three_times(fake_sdk):
    fake_sdk.results = [_response(None, 429), _response(None, 429), _response(None, 429)]
    with pytest.raises(LocalizeError):
        _tts().synthesize("t", "v", 1.0, model=MINIMAX_MODEL)
    assert len(fake_sdk.calls) == 3


def test_minimax_gives_up_at_once_on_a_400(fake_sdk):
    fake_sdk.results = [_response(None, 400)]
    with pytest.raises(LocalizeError):
        _tts().synthesize("t", "v", 1.0, model=MINIMAX_MODEL)
    assert len(fake_sdk.calls) == 1


def test_minimax_recovers_after_one_retryable_failure(fake_sdk):
    fake_sdk.results = [_response(None, 503), _response({"data": {"audio": WAV.hex()}})]
    assert _tts().synthesize("t", "v", 1.0, model=MINIMAX_MODEL) == WAV
    assert len(fake_sdk.calls) == 2


# --- 顺带给 qwen3 补上今天没有的覆盖（它与 MiniMax 共用 _download_audio）-------------


def test_qwen3_still_downloads_its_url_and_sends_language_type(fake_sdk):
    fake_sdk.results = [_response(types.SimpleNamespace(audio={"url": "https://example.test/q.wav"}))]
    assert _tts().synthesize("t", "Cherry", 1.0, model="qwen3-tts-flash", lang="es") == WAV
    assert fake_sdk.downloads == ["https://example.test/q.wav"]
    assert fake_sdk.calls[0]["language_type"] == "Spanish"
    assert "voice_setting" not in fake_sdk.calls[0]  # qwen3 keeps its flat shape


def test_qwen3_reports_a_missing_url(fake_sdk):
    fake_sdk.results = [_response(types.SimpleNamespace(audio={}))]
    with pytest.raises(LocalizeError, match="音频地址"):
        _tts().synthesize("t", "Cherry", 1.0, model="qwen3-tts-flash", lang="es")


# --- 限流节流（HIG-59）------------------------------------------------------------


def test_minimax_paces_itself_to_stay_under_the_models_rpm(monkeypatch):
    """MiniMax 限 20 RPM，而配音是逐句连着调的：主动排队，别撞了墙再靠重试爬回来。"""
    now = [1000.0]
    slept: list[float] = []

    def fake_sleep(seconds: float) -> None:
        slept.append(seconds)
        now[0] += seconds

    monkeypatch.setattr(dp, "_minimax_last_call", 0.0)
    monkeypatch.setattr(dp.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(dp.time, "sleep", fake_sleep)

    dp._minimax_pace()  # 第一次不等
    assert slept == []
    now[0] += 1.0  # 一次合成大约这么久
    dp._minimax_pace()
    assert slept == [pytest.approx(dp.MINIMAX_MIN_INTERVAL - 1.0)]
    # 排过队之后间隔正好是一个周期，所以连着跑的稳态速率不会超过配额
    assert dp.MINIMAX_MIN_INTERVAL * 20 > 60  # 20 次/分钟以内

    slept.clear()
    now[0] += dp.MINIMAX_MIN_INTERVAL + 5  # 自己已经等够了就不该再睡
    dp._minimax_pace()
    assert slept == []


def test_only_minimax_is_paced(fake_sdk, monkeypatch):
    """cosyvoice 与 qwen3 的配额和这个无关，别顺手把它们也拖慢。"""
    called: list[str] = []
    monkeypatch.setattr(dp, "_minimax_pace", lambda: called.append("paced"))
    fake_sdk.results = [_response(types.SimpleNamespace(audio={"url": "https://example.test/q.wav"}))]
    _tts().synthesize("t", "Cherry", 1.0, model="qwen3-tts-flash", lang="es")
    assert called == []
    fake_sdk.results = [_response({"data": {"audio": WAV.hex()}})]
    _tts().synthesize("t", "v", 1.0, model=MINIMAX_MODEL)
    assert called == ["paced"]


# --- on-screen text detection (HIG-38) --------------------------------------


def _vl_response(text: str) -> Any:
    """What MultiModalConversation returns for a vision chat call."""
    message = types.SimpleNamespace(content=[{"text": text}])
    choice = types.SimpleNamespace(message=message)
    return _response(types.SimpleNamespace(choices=[choice]))


def test_parse_detection_json_reads_a_plain_array():
    out = dp.parse_detection_json('[{"text": "限时免费", "box": [0.1, 0.8, 0.5, 0.06], "confidence": 0.93}]')

    assert len(out) == 1
    assert out[0].text == "限时免费"
    assert out[0].box == {"x": 0.1, "y": 0.8, "w": 0.5, "h": 0.06}
    assert out[0].confidence == 0.93


def test_parse_detection_json_survives_a_chatty_model():
    """Told not to, the model still wraps the array in prose or a code fence often enough."""
    out = dp.parse_detection_json('好的，识别结果如下：\n```json\n[{"text": "SALE", "box": [0, 0, 0.2, 0.1]}]\n```')

    assert [d.text for d in out] == ["SALE"]


def test_parse_detection_json_ignores_unrelated_brackets_around_the_answer():
    raw = (
        "坐标格式为 [x1, y1, x2, y2]。识别结果如下：\n"
        '[{"text": "SALE", "bbox_2d": [200, 100, 500, 160]}]\n'
        "以上共有 [1] 项。"
    )

    out = dp.parse_detection_json(raw)

    assert [d.text for d in out] == ["SALE"]


def test_parse_detection_json_prefers_the_real_answer_over_an_empty_array_example():
    out = dp.parse_detection_json(
        '没有文字时输出 []；本图结果是 [{"text": "SALE", "bbox_2d": [200, 100, 500, 160]}]'
    )

    assert [d.text for d in out] == ["SALE"]


def test_parse_detection_json_skips_malformed_items_instead_of_failing_the_frame():
    out = dp.parse_detection_json(
        '[{"text": "好的", "box": [0.1, 0.1, 0.2, 0.05]},'
        ' {"text": "", "box": [0, 0, 1, 1]},'
        ' {"text": "缺框"},'
        ' {"text": "零宽", "box": [0.1, 0.1, 0, 0.05]},'
        ' "不是对象"]'
    )

    assert [d.text for d in out] == ["好的"]


def test_parse_detection_json_returns_nothing_for_junk():
    assert dp.parse_detection_json("模型今天不想说话") == []
    assert dp.parse_detection_json("") == []
    assert dp.parse_detection_json("[不是合法 JSON}") == []


def test_parse_detection_json_reads_qwen3_grid_corners():
    """qwen3-vl answers bbox_2d on a 0–1000 grid regardless of the frame size (checked on real frames)."""
    out = dp.parse_detection_json('[{"text": "赚的多不多", "bbox_2d": [336, 661, 664, 704]}]', scale=dp.SCALE_GRID)

    assert out[0].box == pytest.approx({"x": 0.336, "y": 0.661, "w": 0.328, "h": 0.043})


def test_parse_detection_json_reads_pixel_corners_with_the_frame_size():
    out = dp.parse_detection_json(
        '[{"text": "Radar Detector", "bbox_2d": [108, 516, 223, 534]}]', scale=dp.SCALE_PIXELS, size=(406, 720)
    )

    assert out[0].box == pytest.approx({"x": 108 / 406, "y": 516 / 720, "w": 115 / 406, "h": 18 / 720})


def test_parse_detection_json_skips_pixel_boxes_when_the_size_is_unknown():
    assert dp.parse_detection_json('[{"text": "x", "bbox_2d": [10, 10, 50, 30]}]', scale=dp.SCALE_PIXELS) == []


def test_parse_detection_json_accepts_unit_corners_from_a_pixel_model():
    """qwen-vl-max answered in 0–1 ratios even when pixel corners were expected."""
    out = dp.parse_detection_json('[{"text": "x", "bbox_2d": [0.06, 0.83, 0.94, 0.87]}]', scale=dp.SCALE_PIXELS, size=(406, 720))

    assert out[0].box == pytest.approx({"x": 0.06, "y": 0.83, "w": 0.88, "h": 0.04})


def test_parse_detection_json_orders_and_clamps_corners():
    out = dp.parse_detection_json('[{"text": "x", "bbox_2d": [964, 895, 20, 823]}, {"text": "y", "bbox_2d": [900, 990, 1200, 1100]}]')

    assert out[0].box == pytest.approx({"x": 0.02, "y": 0.823, "w": 0.944, "h": 0.072})
    assert out[1].box == pytest.approx({"x": 0.9, "y": 0.99, "w": 0.1, "h": 0.01})


def test_parse_detection_json_drops_degenerate_corners():
    assert dp.parse_detection_json('[{"text": "x", "bbox_2d": [100, 100, 100, 300]}]') == []


def test_bbox_scale_follows_the_model_family():
    assert dp.bbox_scale_for("qwen3-vl-plus") == dp.SCALE_GRID
    assert dp.bbox_scale_for("qwen3-vl-flash") == dp.SCALE_GRID
    assert dp.bbox_scale_for("qwen-vl-max") == dp.SCALE_PIXELS


def test_screen_text_provider_bounds_each_call_and_reads_grid_boxes(fake_sdk, tmp_path):
    frame = tmp_path / "f0001.jpg"
    frame.write_bytes(b"\xff\xd8\xff")
    fake_sdk.results = [_vl_response('[{"text": "买一送一", "bbox_2d": [200, 100, 500, 160]}]')]
    provider = dp.DashScopeScreenText(api_key="k", model="qwen3-vl-plus", timeout_seconds=45)

    out = provider.detect(frame, hint_lang=None)

    assert fake_sdk.calls[0]["request_timeout"] == 45
    assert out[0].box == pytest.approx({"x": 0.2, "y": 0.1, "w": 0.3, "h": 0.06})


def test_screen_text_provider_rejects_a_malformed_response(fake_sdk, tmp_path):
    frame = tmp_path / "f0001.jpg"
    frame.write_bytes(b"\xff\xd8\xff")
    fake_sdk.results = [_vl_response("我没有按要求返回 JSON")]
    provider = dp.DashScopeScreenText(api_key="k", model="qwen3-vl-plus")

    with pytest.raises(ScreenTextFrameParseError, match="JSON"):
        provider.detect(frame, hint_lang=None)


def test_screen_text_provider_rejects_an_empty_response(fake_sdk, tmp_path):
    frame = tmp_path / "f0001.jpg"
    frame.write_bytes(b"\xff\xd8\xff")
    fake_sdk.results = [_vl_response("")]
    provider = dp.DashScopeScreenText(api_key="k", model="qwen3-vl-plus")

    with pytest.raises(ScreenTextFrameParseError, match="没有返回内容"):
        provider.detect(frame, hint_lang=None)


def test_screen_text_provider_sends_the_frame_and_the_model(fake_sdk, tmp_path):
    frame = tmp_path / "f0001.jpg"
    frame.write_bytes(b"\xff\xd8\xff")
    fake_sdk.results = [_vl_response('[{"text": "买一送一", "box": [0.2, 0.1, 0.3, 0.06]}]')]
    provider = dp.DashScopeScreenText(api_key="k", model="qwen-vl-max-latest")

    out = provider.detect(frame, hint_lang="zh")

    assert [d.text for d in out] == ["买一送一"]
    call = fake_sdk.calls[0]
    assert call["model"] == "qwen-vl-max-latest"
    content = call["messages"][0]["content"]
    assert content[0]["image"].startswith("file://")
    assert "zh" in content[1]["text"]


def test_screen_text_provider_retries_a_throttled_call(fake_sdk, tmp_path):
    frame = tmp_path / "f0001.jpg"
    frame.write_bytes(b"\xff\xd8\xff")
    fake_sdk.results = [_response(None, status=429), _vl_response("[]")]
    provider = dp.DashScopeScreenText(api_key="k", model="qwen-vl-max-latest")

    assert provider.detect(frame, hint_lang=None) == []
    assert len(fake_sdk.calls) == 2


def test_screen_text_provider_raises_chinese_on_a_hard_error(fake_sdk, tmp_path):
    frame = tmp_path / "f0001.jpg"
    frame.write_bytes(b"\xff\xd8\xff")
    fake_sdk.results = [_response(None, status=400)]
    provider = dp.DashScopeScreenText(api_key="k", model="qwen-vl-max-latest")

    with pytest.raises(LocalizeError, match="画面文字识别"):
        provider.detect(frame, hint_lang=None)
