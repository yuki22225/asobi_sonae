// ホームのお知らせ欄：data/news.json の先頭（一番新しいもの）を出す
fetch('data/news.json')
  .then(res => res.json())
  .then(news => {
    if (!Array.isArray(news) || news.length === 0) return;
    document.getElementById('news-date').textContent = news[0].date || '';
    document.getElementById('news-text').textContent = news[0].text;
    document.getElementById('news-banner').hidden = false;
  })
  .catch(() => {});
