import shutil
import subprocess

from PIL import Image
from pydantic import ValidationError
import pytest

from app.models import Batch, Job, Video
from app.routers.render import resolved_output_format
from app.schemas import RenderIn
from app.services import storage
from app.services.render import render_job
from tests.conftest import make_png, valid_spec


@pytest.mark.parametrize(
    ("name", "expected"),
    [("movie.mov", "mov"), ("still.PNG", "png"), ("photo.jpeg", "jpg"), ("generated", "mp4")],
)
def test_source_output_format_uses_original_name(name, expected):
    video = Video(id="v1", batch_id="b1", name=name)
    assert resolved_output_format("source", video) == expected
    assert resolved_output_format("jpg", video) == "jpg"


def test_render_request_format_defaults_to_mp4_for_old_clients():
    assert RenderIn(video_ids=["v1"]).output_format == "mp4"
    with pytest.raises(ValidationError):
        RenderIn(video_ids=["v1"], output_format="gif")


def test_source_output_format_survives_video_rename():
    video = Video(id="v1", batch_id="b1", name="renamed clip", kind="video", source_ext="mov", original_ext="mov")
    assert resolved_output_format("source", video) == "mov"
    image = Video(id="v2", batch_id="b1", name="renamed still", kind="image", source_ext="mp4", original_ext="png")
    assert resolved_output_format("source", image) == "png"


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="needs ffmpeg")
@pytest.mark.parametrize("output_format", ["mov", "png", "jpg"])
def test_real_render_writes_selected_format_and_shape(db, output_format):
    batch = Batch(id="b_format_test", name="formats")
    shape_url = "/media/uploads/u_format_shape.png"
    make_png(storage.upload_path("u_format_shape"), (54, 96))
    spec = valid_spec(
        trim={"remove": []},
        layers=[{
            "id": "l_shape", "type": "shape", "shape": "rect", "image_url": shape_url,
            "image_size": [54, 96], "anchor": "top-left", "margin": [0, 0],
            "width": 1, "height": 1, "rotate": 0, "opacity": 1, "t": "all",
        }],
        outputs=[{"variant_key": "custom", "aspect": "custom", "fill": "color", "color": "#0000FF", "width": 54, "height": 96}],
    )
    video = Video(
        id="v_format_test", batch_id=batch.id, name="source.mp4", status="ready",
        order_index=0, kind="video", source_ext="mp4", duration=0.5,
        width=54, height=96, fps=10, has_audio=False, edit_spec=spec,
    )
    job = Job(id="j_format_test", batch_id=batch.id, video_id=video.id, variant_key="custom", output_format=output_format)
    db.add_all([batch, video, job])
    db.commit()
    source = storage.source_path(batch.id, video.id)
    source.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=54x96:r=10:d=0.5",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source),
    ], check=True, capture_output=True)

    render_job(db, job.id)
    db.refresh(job)
    output = storage.output_path(job.id, output_format)
    assert job.status == "done" and output.is_file()
    assert job.callback["output"]["url"].endswith(f".{output_format}")
    assert job.output["width"] == 54 and job.output["height"] == 96
    if output_format in {"png", "jpg"}:
        with Image.open(output) as frame:
            r, _, b = frame.convert("RGB").getpixel((27, 48))
            assert r > b  # the red shape reaches the final still frame
    else:
        assert job.output["duration"] == pytest.approx(0.5, abs=0.15)
