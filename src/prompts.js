// Prompt có sẵn cho chế độ Dịch và Viết content

export const LANGUAGES = {
  auto: 'Tự nhận diện', vi: 'Tiếng Việt', en: 'Tiếng Anh', zh: 'Tiếng Trung (giản thể)', 'zh-TW': 'Tiếng Trung (phồn thể)',
  ja: 'Tiếng Nhật', ko: 'Tiếng Hàn', fr: 'Tiếng Pháp', de: 'Tiếng Đức', es: 'Tiếng Tây Ban Nha', ru: 'Tiếng Nga',
  th: 'Tiếng Thái', id: 'Tiếng Indonesia', lo: 'Tiếng Lào', km: 'Tiếng Khmer', pt: 'Tiếng Bồ Đào Nha', it: 'Tiếng Ý',
};

export const TRANSLATE_STYLES = {
  natural: 'tự nhiên, trôi chảy như người bản xứ viết',
  literal: 'sát nghĩa từng câu, giữ nguyên cấu trúc',
  formal: 'trang trọng, lịch sự (văn bản hành chính, công việc)',
  casual: 'thân mật, đời thường (tin nhắn, mạng xã hội)',
  technical: 'chính xác thuật ngữ chuyên ngành, giữ nguyên tên riêng và mã code',
};

export const CONTENT_KINDS = {
  facebook: 'bài đăng Facebook thu hút tương tác, có emoji vừa phải và hashtag cuối bài',
  tiktok: 'kịch bản video TikTok/Reels ngắn: câu mở đầu giữ chân người xem trong 3 giây đầu, các cảnh, lời thoại, kêu gọi hành động',
  blog: 'bài blog có tiêu đề, mở bài, các mục có tiêu đề phụ, kết luận',
  seo: 'bài viết chuẩn SEO: tiêu đề chứa từ khóa, meta description, các heading H2/H3, từ khóa phân bố tự nhiên',
  ads: 'nội dung quảng cáo: tiêu đề ngắn, nêu lợi ích, nỗi đau khách hàng, kêu gọi hành động rõ ràng',
  product: 'mô tả sản phẩm bán hàng: đặc điểm nổi bật, lợi ích, thông số, lý do nên mua',
  email: 'email chuyên nghiệp có tiêu đề, lời chào, nội dung, lời kết',
  caption: 'vài caption ngắn gọn, bắt trend để chọn',
  idea: 'danh sách ý tưởng nội dung, mỗi ý có tiêu đề và mô tả ngắn',
  rewrite: 'viết lại nội dung được cung cấp cho hay hơn, giữ nguyên ý',
};

export const CONTENT_TONES = {
  friendly: 'thân thiện, gần gũi',
  professional: 'chuyên nghiệp, đáng tin cậy',
  funny: 'hài hước, dí dỏm',
  inspiring: 'truyền cảm hứng',
  urgent: 'khẩn trương, tạo cảm giác khan hiếm',
  luxury: 'sang trọng, đẳng cấp',
  youthful: 'trẻ trung, năng động, dùng ngôn ngữ Gen Z',
};

export const CONTENT_LENGTHS = {
  short: 'ngắn (khoảng 50-100 từ)',
  medium: 'vừa (khoảng 150-300 từ)',
  long: 'dài (khoảng 500-800 từ)',
};

const lang = (code) => LANGUAGES[code] || code;

export function buildTranslate({ text, to = 'vi', from = 'auto', style = 'natural' }) {
  const src = from === 'auto' ? 'tự nhận diện ngôn ngữ nguồn' : `từ ${lang(from)}`;
  const system = [
    'Bạn là phiên dịch viên chuyên nghiệp.',
    `Dịch văn bản người dùng gửi ${src} sang ${lang(to)}.`,
    `Phong cách: ${TRANSLATE_STYLES[style] || style}.`,
    'Quy tắc: CHỈ trả về bản dịch, không giải thích, không thêm lời mở đầu, không đặt trong dấu ngoặc kép.',
    'Giữ nguyên định dạng (xuống dòng, gạch đầu dòng, markdown), emoji, URL, số liệu.',
    'Nếu văn bản đã là ngôn ngữ đích thì trả lại nguyên văn đã chỉnh sửa lỗi chính tả.',
  ].join('\n');
  return { system, prompt: text };
}

export function buildContent({ topic, kind = 'facebook', tone = 'friendly', length = 'medium', language = 'vi', keywords = '', audience = '', extra = '' }) {
  const system = [
    'Bạn là chuyên gia viết content marketing.',
    `Viết bằng ${lang(language)}.`,
    `Loại nội dung: ${CONTENT_KINDS[kind] || kind}.`,
    `Giọng văn: ${CONTENT_TONES[tone] || tone}.`,
    `Độ dài: ${CONTENT_LENGTHS[length] || length}.`,
    keywords ? `Từ khóa cần có: ${keywords}.` : '',
    audience ? `Đối tượng đọc: ${audience}.` : '',
    'Trả về nội dung hoàn chỉnh, sẵn sàng đăng, không giải thích cách viết.',
  ].filter(Boolean).join('\n');
  const prompt = kind === 'rewrite' ? `Nội dung cần viết lại:\n${topic}` : `Chủ đề: ${topic}`;
  return { system, prompt: extra ? `${prompt}\n\nYêu cầu thêm: ${extra}` : prompt };
}
