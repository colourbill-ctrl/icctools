import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

// I18N dictionary. EN is the source-of-truth; missing keys fall back to EN.
// Strings here are TRUSTED HTML — callers using `t()` in attribute/handler
// contexts should still escape any user-derived interpolated values.
// Match chardata's set of supported locales so the Language dropdown is
// consistent across the two apps.
export const I18N = {
  en: {
    settings: 'Settings', display: 'Display',
    background: 'Background', language: 'Language',
    system: 'System', light: 'Light', dark: 'Dark',
    system_default: 'System default',
    help: 'Help', contact: 'Contact',
    app_title: 'ICC Profile Validator',
    banner_part1: 'Upload an ICC profile to validate it against the',
    banner_part2: 'specification using the',
    banner_part3: 'reference implementation.',
    validating: 'Validating…',
    save_profile: 'Save ICC profile',
    modified_pill: '● Modified — unsaved edits',
    dropzone_headline: 'Drop an ICC profile here',
    dropzone_or: 'or',
    dropzone_button: 'Choose file',
    dropzone_hint: '.icc and .icm files',
    tab_header: 'Header', tab_tags: 'Tags', tab_validation: 'Validation',
    tab_raw: 'Raw Output', tab_xml: 'XML', tab_json: 'JSON',
    footer: 'ICC Profile Validator · powered by IccProfLib',
    error_label: 'Error:',
  },
  fr: {
    settings: 'Paramètres', display: 'Affichage',
    background: 'Arrière-plan', language: 'Langue',
    system: 'Système', light: 'Clair', dark: 'Sombre',
    system_default: 'Par défaut du système',
    help: 'Aide', contact: 'Contact',
    app_title: 'Validateur de profil ICC',
    banner_part1: 'Téléversez un profil ICC pour le valider selon la spécification',
    banner_part2: 'à l’aide de l’implémentation de référence',
    banner_part3: '.',
    validating: 'Validation…',
    save_profile: 'Enregistrer le profil ICC',
    modified_pill: '● Modifié — non enregistré',
    dropzone_headline: 'Déposez un profil ICC ici',
    dropzone_or: 'ou',
    dropzone_button: 'Choisir un fichier',
    dropzone_hint: 'Fichiers .icc et .icm',
    tab_header: 'En-tête', tab_tags: 'Balises', tab_validation: 'Validation',
    tab_raw: 'Sortie brute', tab_xml: 'XML', tab_json: 'JSON',
    footer: 'Validateur de profil ICC · propulsé par IccProfLib',
    error_label: 'Erreur :',
  },
  de: {
    settings: 'Einstellungen', display: 'Anzeige',
    background: 'Hintergrund', language: 'Sprache',
    system: 'System', light: 'Hell', dark: 'Dunkel',
    system_default: 'Systemstandard',
    help: 'Hilfe', contact: 'Kontakt',
    app_title: 'ICC-Profilvalidator',
    banner_part1: 'Laden Sie ein ICC-Profil hoch, um es gegen die Spezifikation',
    banner_part2: 'mit der Referenzimplementierung',
    banner_part3: 'zu validieren.',
    validating: 'Validierung…',
    save_profile: 'ICC-Profil speichern',
    modified_pill: '● Geändert — nicht gespeichert',
    dropzone_headline: 'ICC-Profil hierher ziehen',
    dropzone_or: 'oder',
    dropzone_button: 'Datei wählen',
    dropzone_hint: '.icc- und .icm-Dateien',
    tab_header: 'Header', tab_tags: 'Tags', tab_validation: 'Validierung',
    tab_raw: 'Rohausgabe', tab_xml: 'XML', tab_json: 'JSON',
    footer: 'ICC-Profilvalidator · betrieben mit IccProfLib',
    error_label: 'Fehler:',
  },
  it: {
    settings: 'Impostazioni', display: 'Visualizzazione',
    background: 'Sfondo', language: 'Lingua',
    system: 'Sistema', light: 'Chiaro', dark: 'Scuro',
    system_default: 'Predefinito di sistema',
    help: 'Aiuto', contact: 'Contatto',
    app_title: 'Validatore di profili ICC',
    banner_part1: 'Carica un profilo ICC per convalidarlo rispetto alla specifica',
    banner_part2: 'utilizzando l’implementazione di riferimento',
    banner_part3: '.',
    validating: 'Convalida…',
    save_profile: 'Salva profilo ICC',
    modified_pill: '● Modificato — non salvato',
    dropzone_headline: 'Trascina qui un profilo ICC',
    dropzone_or: 'oppure',
    dropzone_button: 'Scegli file',
    dropzone_hint: 'File .icc e .icm',
    tab_header: 'Intestazione', tab_tags: 'Tag', tab_validation: 'Convalida',
    tab_raw: 'Output grezzo', tab_xml: 'XML', tab_json: 'JSON',
    footer: 'Validatore di profili ICC · realizzato con IccProfLib',
    error_label: 'Errore:',
  },
  es: {
    settings: 'Ajustes', display: 'Visualización',
    background: 'Fondo', language: 'Idioma',
    system: 'Sistema', light: 'Claro', dark: 'Oscuro',
    system_default: 'Predeterminado del sistema',
    help: 'Ayuda', contact: 'Contacto',
    app_title: 'Validador de perfiles ICC',
    banner_part1: 'Sube un perfil ICC para validarlo según la especificación',
    banner_part2: 'usando la implementación de referencia',
    banner_part3: '.',
    validating: 'Validando…',
    save_profile: 'Guardar perfil ICC',
    modified_pill: '● Modificado — sin guardar',
    dropzone_headline: 'Suelta un perfil ICC aquí',
    dropzone_or: 'o',
    dropzone_button: 'Elegir archivo',
    dropzone_hint: 'Archivos .icc y .icm',
    tab_header: 'Encabezado', tab_tags: 'Etiquetas', tab_validation: 'Validación',
    tab_raw: 'Salida bruta', tab_xml: 'XML', tab_json: 'JSON',
    footer: 'Validador de perfiles ICC · con tecnología de IccProfLib',
    error_label: 'Error:',
  },
  'pt-PT': {
    settings: 'Definições', display: 'Visualização',
    background: 'Fundo', language: 'Idioma',
    system: 'Sistema', light: 'Claro', dark: 'Escuro',
    system_default: 'Predefinição do sistema',
    help: 'Ajuda', contact: 'Contacto',
    app_title: 'Validador de perfis ICC',
    banner_part1: 'Carregue um perfil ICC para o validar segundo a especificação',
    banner_part2: 'através da implementação de referência',
    banner_part3: '.',
    validating: 'A validar…',
    save_profile: 'Guardar perfil ICC',
    modified_pill: '● Modificado — não guardado',
    dropzone_headline: 'Largue um perfil ICC aqui',
    dropzone_or: 'ou',
    dropzone_button: 'Escolher ficheiro',
    dropzone_hint: 'Ficheiros .icc e .icm',
    tab_header: 'Cabeçalho', tab_tags: 'Etiquetas', tab_validation: 'Validação',
    tab_raw: 'Saída em bruto', tab_xml: 'XML', tab_json: 'JSON',
    footer: 'Validador de perfis ICC · com IccProfLib',
    error_label: 'Erro:',
  },
  'pt-BR': {
    settings: 'Configurações', display: 'Exibição',
    background: 'Fundo', language: 'Idioma',
    system: 'Sistema', light: 'Claro', dark: 'Escuro',
    system_default: 'Padrão do sistema',
    help: 'Ajuda', contact: 'Contato',
    app_title: 'Validador de perfis ICC',
    banner_part1: 'Envie um perfil ICC para validá-lo conforme a especificação',
    banner_part2: 'usando a implementação de referência',
    banner_part3: '.',
    validating: 'Validando…',
    save_profile: 'Salvar perfil ICC',
    modified_pill: '● Modificado — não salvo',
    dropzone_headline: 'Solte um perfil ICC aqui',
    dropzone_or: 'ou',
    dropzone_button: 'Escolher arquivo',
    dropzone_hint: 'Arquivos .icc e .icm',
    tab_header: 'Cabeçalho', tab_tags: 'Tags', tab_validation: 'Validação',
    tab_raw: 'Saída bruta', tab_xml: 'XML', tab_json: 'JSON',
    footer: 'Validador de perfis ICC · com IccProfLib',
    error_label: 'Erro:',
  },
  sv: {
    settings: 'Inställningar', display: 'Visning',
    background: 'Bakgrund', language: 'Språk',
    system: 'System', light: 'Ljus', dark: 'Mörk',
    system_default: 'Systemstandard',
    help: 'Hjälp', contact: 'Kontakt',
    app_title: 'ICC-profilvalidator',
    banner_part1: 'Ladda upp en ICC-profil för att validera den mot specifikationen',
    banner_part2: 'med referensimplementeringen',
    banner_part3: '.',
    validating: 'Validerar…',
    save_profile: 'Spara ICC-profil',
    modified_pill: '● Ändrad — osparad',
    dropzone_headline: 'Släpp en ICC-profil här',
    dropzone_or: 'eller',
    dropzone_button: 'Välj fil',
    dropzone_hint: '.icc- och .icm-filer',
    tab_header: 'Rubrik', tab_tags: 'Taggar', tab_validation: 'Validering',
    tab_raw: 'Rådata', tab_xml: 'XML', tab_json: 'JSON',
    footer: 'ICC-profilvalidator · drivs av IccProfLib',
    error_label: 'Fel:',
  },
  'zh-CN': {
    settings: '设置', display: '显示',
    background: '背景', language: '语言',
    system: '系统', light: '浅色', dark: '深色',
    system_default: '系统默认',
    help: '帮助', contact: '联系',
    app_title: 'ICC 配置文件验证器',
    banner_part1: '上传一个 ICC 配置文件，依据',
    banner_part2: '规范使用',
    banner_part3: '参考实现进行验证。',
    validating: '正在验证…',
    save_profile: '保存 ICC 配置文件',
    modified_pill: '● 已修改 — 尚未保存',
    dropzone_headline: '将 ICC 配置文件拖到此处',
    dropzone_or: '或',
    dropzone_button: '选择文件',
    dropzone_hint: '.icc 和 .icm 文件',
    tab_header: '标头', tab_tags: '标签', tab_validation: '验证',
    tab_raw: '原始输出', tab_xml: 'XML', tab_json: 'JSON',
    footer: 'ICC 配置文件验证器 · 由 IccProfLib 提供支持',
    error_label: '错误：',
  },
  'zh-TW': {
    settings: '設定', display: '顯示',
    background: '背景', language: '語言',
    system: '系統', light: '淺色', dark: '深色',
    system_default: '系統預設',
    help: '說明', contact: '聯絡',
    app_title: 'ICC 設定檔驗證器',
    banner_part1: '上傳一個 ICC 設定檔，依據',
    banner_part2: '規範使用',
    banner_part3: '參考實作進行驗證。',
    validating: '驗證中…',
    save_profile: '儲存 ICC 設定檔',
    modified_pill: '● 已修改 — 尚未儲存',
    dropzone_headline: '將 ICC 設定檔拖到此處',
    dropzone_or: '或',
    dropzone_button: '選擇檔案',
    dropzone_hint: '.icc 與 .icm 檔案',
    tab_header: '標頭', tab_tags: '標籤', tab_validation: '驗證',
    tab_raw: '原始輸出', tab_xml: 'XML', tab_json: 'JSON',
    footer: 'ICC 設定檔驗證器 · 由 IccProfLib 提供支援',
    error_label: '錯誤：',
  },
  ja: {
    settings: '設定', display: '表示',
    background: '背景', language: '言語',
    system: 'システム', light: 'ライト', dark: 'ダーク',
    system_default: 'システム既定',
    help: 'ヘルプ', contact: 'お問い合わせ',
    app_title: 'ICC プロファイル検証ツール',
    banner_part1: 'ICC プロファイルをアップロードし、',
    banner_part2: '仕様を',
    banner_part3: 'リファレンス実装で検証します。',
    validating: '検証中…',
    save_profile: 'ICC プロファイルを保存',
    modified_pill: '● 変更あり — 未保存',
    dropzone_headline: 'ここに ICC プロファイルをドロップ',
    dropzone_or: 'または',
    dropzone_button: 'ファイルを選択',
    dropzone_hint: '.icc および .icm ファイル',
    tab_header: 'ヘッダー', tab_tags: 'タグ', tab_validation: '検証',
    tab_raw: '生出力', tab_xml: 'XML', tab_json: 'JSON',
    footer: 'ICC プロファイル検証ツール · IccProfLib 採用',
    error_label: 'エラー:',
  },
  ko: {
    settings: '설정', display: '표시',
    background: '배경', language: '언어',
    system: '시스템', light: '밝게', dark: '어둡게',
    system_default: '시스템 기본값',
    help: '도움말', contact: '문의',
    app_title: 'ICC 프로파일 검증기',
    banner_part1: 'ICC 프로파일을 업로드하여',
    banner_part2: '사양을',
    banner_part3: '참조 구현으로 검증합니다.',
    validating: '검증 중…',
    save_profile: 'ICC 프로파일 저장',
    modified_pill: '● 변경됨 — 저장되지 않음',
    dropzone_headline: 'ICC 프로파일을 여기에 놓기',
    dropzone_or: '또는',
    dropzone_button: '파일 선택',
    dropzone_hint: '.icc 및 .icm 파일',
    tab_header: '헤더', tab_tags: '태그', tab_validation: '검증',
    tab_raw: '원시 출력', tab_xml: 'XML', tab_json: 'JSON',
    footer: 'ICC 프로파일 검증기 · IccProfLib 기반',
    error_label: '오류:',
  },
}

const LANG_NATIVE = {
  en: 'English', fr: 'Français', de: 'Deutsch', it: 'Italiano',
  es: 'Español', 'pt-PT': 'Português', 'pt-BR': 'Português',
  sv: 'Svenska',
  'zh-CN': '中文（简体）', 'zh-TW': '中文（繁體）',
  ja: '日本語', ko: '한국어',
}

export const LANG_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'it', label: 'Italiano' },
  { value: 'es', label: 'Español' },
  { value: 'pt-PT', label: 'Português (PT)' },
  { value: 'pt-BR', label: 'Português (BR)' },
  { value: 'sv', label: 'Svenska' },
  { value: 'zh-CN', label: '中文（简体）' },
  { value: 'zh-TW', label: '中文（繁體）' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]

function detectLang() {
  const supported = Object.keys(I18N)
  for (const pref of (navigator.languages || [navigator.language])) {
    if (!pref) continue
    if (supported.includes(pref)) return pref
    const base = pref.split('-')[0]
    const match = supported.find(s => s.startsWith(base + '-') || s === base)
    if (match) return match
  }
  return 'en'
}

export function systemLangNative() {
  return LANG_NATIVE[detectLang()] || 'English'
}

const LangContext = createContext(null)

export function LangProvider({ children }) {
  const [lang, setLangState] = useState(() => localStorage.getItem('icctools.lang') || 'system')

  const setLang = useCallback((next) => {
    setLangState(next)
    localStorage.setItem('icctools.lang', next)
  }, [])

  const resolved = lang === 'system' ? detectLang() : lang

  const t = useCallback((key, vars) => {
    const dict = I18N[resolved] || I18N.en
    let s = dict[key] ?? I18N.en[key] ?? key
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll('{' + k + '}', String(v))
    return s
  }, [resolved])

  useEffect(() => {
    document.documentElement.lang = resolved
  }, [resolved])

  const value = useMemo(() => ({ lang, setLang, resolved, t }), [lang, setLang, resolved, t])
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}

export function useLang() {
  const ctx = useContext(LangContext)
  if (!ctx) throw new Error('useLang must be used inside <LangProvider>')
  return ctx
}

export function useT() {
  return useLang().t
}
