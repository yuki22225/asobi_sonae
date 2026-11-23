# 遊んで、備える

広島県の防災データ（DoboX）を使って、遊びながら避難について考えるウェブアプリです。

- **地図**：災害の種類ごとに避難所と危険範囲（土砂災害・洪水・津波・高潮）を表示し、仮の現在地から危険範囲をなるべく避けた道を探せます。自分で経路を引いて保存することもできます。
- **チェックシート**：災害への備えを確かめます（準備中）。
- **ミニゲーム**：避難について考えるゲームです。

## 使っているデータ

| データ | 出典 | ライセンス |
|---|---|---|
| 避難所、土砂災害警戒区域、洪水・津波・高潮の浸水想定 | 広島県 DoboX | 各データの利用条件に従う |
| 道（`data/roads`） | © OpenStreetMap contributors | ODbL 1.0 |
| 背景の地図 | 国土地理院 淡色地図 | 国土地理院コンテンツ利用規約 |

`data/roads` は OpenStreetMap を加工したデータベースで、ODbL 1.0 で公開します。

## データの作り方

```
python tools/convert_shelters.py   # 避難所
python tools/convert_hazard.py     # 危険範囲（shapely, pyshp, pyproj）
python tools/build_roads.py 地図.osm.pbf   # 道（osmium, shapely。危険範囲を先に作る）
```
