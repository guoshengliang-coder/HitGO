// 音色下拉 + 试听（HIG-42）：大字报朗读和改语言的三处音色选择共用。
// 下拉按 groupVoices 分成女声 / 男声 / 特色的 optgroup；旁边的 ▶ 请后端合成一句固定试听文案（GET /api/tts/preview，
// 服务端按音色缓存）后播放。整个编辑器同一时间只播一条试听：再点、换音色、或另一处开始试听都会停掉当前这条。

import { useEffect, useState } from 'react';
import { api } from '../../api';
import { groupVoices, voiceOptionLabel } from '../../lib/localize';
import { useEditor } from '../../store/editor';
import type { VoiceOption } from '../../types';
import { IconPause, IconPlay, IconSpinner } from '../ui/Icons';

/** 正在播的那条试听：Audio 元素、是哪个音色、停下时通知哪个组件。 */
let playing: { audio: HTMLAudioElement; key: string; onStop: () => void } | null = null;
/** 已拿到的试听 URL（object URL / mock 的 data URL）：同一音色不重复请求。 */
const urls = new Map<string, string>();

function previewKey(lang: string, voice: string) {
  return `${lang}/${voice}`;
}

/** 停掉当前试听（无论是哪个组件起的）。 */
export function stopVoicePreview() {
  if (!playing) return;
  const cur = playing;
  playing = null;
  cur.audio.pause();
  cur.audio.removeAttribute('src');
  cur.onStop();
}

interface Props {
  lang: string;
  voices: VoiceOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  /** value 不在列表里时也给它一个 option（改语言的版本行：旧版本用的音色可能已下线）。 */
  keepUnknown?: boolean;
}

export function VoiceSelect({ lang, voices, value, onChange, disabled, ariaLabel, keepUnknown }: Props) {
  const setToast = useEditor((s) => s.setToast);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(false);
  const key = previewKey(lang, value);
  const groups = groupVoices(voices);
  const known = voices.some((v) => v.id === value);

  // 换了音色 / 卸载：这条正在播就停
  useEffect(() => {
    return () => {
      if (playing?.key === key) stopVoicePreview();
    };
  }, [key]);

  const toggle = async () => {
    if (playing?.key === key) {
      stopVoicePreview();
      return;
    }
    stopVoicePreview();
    setBusy(true);
    try {
      let url = urls.get(key);
      if (!url) {
        url = await api.ttsPreview(lang, value);
        urls.set(key, url);
      }
      const audio = new Audio(url);
      const me = { audio, key, onStop: () => setActive(false) };
      audio.onended = () => {
        if (playing === me) stopVoicePreview();
      };
      audio.onerror = () => {
        if (playing === me) stopVoicePreview();
        setToast('试听播放失败');
      };
      playing = me;
      setActive(true);
      await audio.play();
    } catch (e) {
      if (playing?.key === key) stopVoicePreview();
      setToast(`试听失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <select className="select sm" value={value} disabled={disabled || !voices.length} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)}>
        {keepUnknown && !known && <option value={value}>{value || '默认音色'}</option>}
        {groups.map((g) =>
          g.key === 'all' ? (
            g.voices.map((v) => (
              <option key={v.id} value={v.id}>{voiceOptionLabel(v)}</option>
            ))
          ) : (
            <optgroup key={g.key} label={g.label}>
              {g.voices.map((v) => (
                <option key={v.id} value={v.id}>{voiceOptionLabel(v)}</option>
              ))}
            </optgroup>
          ),
        )}
      </select>
      <button
        type="button"
        className={`btn icon ghost sm ${active ? 'active' : ''}`}
        disabled={disabled || !known || busy}
        aria-label={active ? '停止试听' : '试听这个音色'}
        title={active ? '停止试听' : '试听这个音色（一句固定文案，首次要等几秒合成）'}
        onClick={() => void toggle()}
      >
        {busy ? <IconSpinner /> : active ? <IconPause /> : <IconPlay />}
      </button>
    </>
  );
}
