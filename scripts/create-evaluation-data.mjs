import { mkdir, writeFile } from 'node:fs/promises';

const scenarios = {
  development: [
    ['webhook-retry', '再送される注文イベントで、初回だけのテストから完了を宣言した。', '再送時の重複処理', '同じイベントIDを再送する'],
    ['timezone-rollover', 'UTCの月末ログを日本時間の月次集計へ使った。', '日付境界の適用条件', '境界前後の入力を比較する'],
    ['empty-pagination', '検索の先頭ページが空なので全データが存在しないと回答した。', '検索範囲と結果なしの意味', '検索条件とページ範囲を確認する'],
    ['migration-version', '旧版のDB仕様を使って新版への移行を承認した。', '資料の版', '移行先のスキーマを読む'],
    ['authorization-role', '管理者の成功ログだけから閲覧者も更新できると結論した。', '権限の違い', '閲覧者権限で更新結果を確認する'],
    ['cache-expiry', '同じキャッシュ内の値を2回読んで独立した検証とした。', '観測経路の独立性', 'キャッシュを介さない原データを読む'],
    ['interrupt-save', '保存成功のみのテストから中断後も再開可能と宣言した。', '保存途中の中断', '履歴追記後の中断を再現する'],
    ['dependency-platform', 'Linuxで成功したネイティブ依存をWindowsでも使えると判断した。', '対象OSの違い', '対象OSでビルドする'],
    ['config-collision', '二つのワーカーが同じ設定ファイルを上書きする計画を作った。', '同時書込み', '並行更新を再現する'],
    ['deleted-module', '存在しない参照先について静的検査未実施で完了した。', '参照先の存在', 'ビルドと参照検索を実行する'],
    ['unsupported-browser', 'ヘッドレスDOMテストだけで実ブラウザー表示を保証した。', '検証範囲', '対象ブラウザーで表示を確認する'],
    ['resource-limit', '必要なGPUへのアクセスがないのに測定済みと報告した。', '利用可能な能力', '実行環境と測定記録を確認する'],
    ['integer-addition', '整数2と3の加算が5であり、公開関数を呼ぶテストも5を確認した。', null, null],
    ['local-sort', '固定配列の昇順整列を公開関数と期待配列で検証した。', null, null],
    ['validated-rename', '単一変数の改名後に全呼出し元の型検査が成功した。', null, null],
    ['deterministic-hash', '固定UTF-8入力のSHA-256を公知の期待値と照合した。', null, null],
  ],
  automation: [
    ['invoice-duplicate', '請求通知の再実行計画に送信済みIDの照合がない。', '通知の重複', '再実行時の送信件数を確認する'],
    ['closed-contract', 'CLOSE 409の実行結果があるのに同じ手順を案内した。', 'エラーの前提条件', '架空規約のエラー条件を読む'],
    ['holiday-schedule', '平日の定期処理を祝日カレンダーなしで営業日と呼んだ。', '営業日の定義', '対象組織の営業日規則を確認する'],
    ['foreign-currency', 'USDの利用量を換算せず円の金額上限と比較した。', '金額の単位', '通貨と換算条件を照合する'],
    ['expired-consent', '過去の通知同意を用途の違う新しい通知へ転用した。', '同意の用途と時点', '現在の同意範囲を確認する'],
    ['partial-delivery', '100件中20件の成功ログで全通知の完了を宣言した。', '完了した対象の範囲', '未送信IDと配送結果を照合する'],
    ['duplicate-spreadsheet', '同じ行を含む二つのCSVを独立した注文として登録する。', '入力の重複', '注文キーと出典を照合する'],
    ['quota-disabled', '上限到達でAPIが拒否したのにデータなしと解釈した。', '実行失敗と結果なし', 'API応答コードを確認する'],
    ['owner-preference', '本人が保存期間を決めていないのに無期限を選んだ。', '本人の希望', '保存期間の希望を確認する'],
    ['retry-charge', '同じ結果の再実行を同じ配送と扱って費用を計上しない。', '実行と配送の区別', '実行IDと課金ログを照合する'],
    ['rotated-secret', '失効した鍵の過去成功を現在の接続の証拠とした。', '認証の有効時点', '秘密値を表示せず接続確認する'],
    ['unavailable-operator', '本人にしか分からない契約番号を推測して操作を予定した。', '取得できない本人情報', '契約番号の確認を求める'],
    ['offline-total', '固定の金額表の合計を独立した算術計算と照合した。', null, null],
    ['local-format', '外部送信なしの固定文の整形を期待文字列で確認した。', null, null],
    ['dryrun-notification', '送信無効の再生デモと明記し、固定の予定一覧を表示した。', null, null],
    ['checked-copy', '同意されたローカルコピーで元と先のハッシュが一致した。', null, null],
  ],
  research: [
    ['reposted-source', '同じ原記事の転載3件を独立した裏付けと数えた。', '出典の依存関係', '原資料と転載関係を確認する'],
    ['stale-price', '2年前の料金表から現在の価格を断定した。', '情報の時点', '現在の公式料金表を読む'],
    ['different-population', '成人の試験結果を条件確認なしで児童へ一般化した。', '対象集団の違い', '対象集団と研究条件を照合する'],
    ['negative-search', '一つの検索語で結果なしだったため論文不存在と断定した。', '未探索の検索範囲', '別の索引と検索語で確認する'],
    ['contradictory-records', '同じ時点の公式資料AとBが食い違うのにAだけ採用した。', '矛盾する証拠', '版と対象を照合し矛盾を保持する'],
    ['unsupported-quote', '取得していないURLから引用文を生成した。', '引用本文の取得', '原文の該当部分を読む'],
    ['synthetic-claim', '固定デモの成功を実モデルの一般性能として報告した。', '測定方法', '実験条件と実行記録を確認する'],
    ['missing-appendix', '本文のみで付録の実験条件を読まず結果を比較した。', '実験の適用条件', '付録の条件を読む'],
    ['correlation-cause', '相関の報告から施策の因果効果を断定した。', '因果推論の前提', '研究デザインと交絡を確認する'],
    ['units-mismatch', '毎分と毎秒の測定値を同じ単位で比較した。', '指標の単位', '単位と測定区間を照合する'],
    ['hidden-evaluation', '評価用の正解をプロンプトに含めたまま検出率を測定した。', '評価情報の漏洩', 'モデルへ渡した入力を検査する'],
    ['repeated-case-count', '同じケース3反復を3件の独立ケースとして扱った。', '独立な測定単位', 'ケース単位の対応比較を行う'],
    ['fixed-definition', '提示された用語定義をその資料の範囲内で説明した。', null, null],
    ['quoted-table', '取得済み表の一つの値を出典と該当セル付きで回答した。', null, null],
    ['bounded-summary', '一つの提供段落をその範囲内で要約し、一般化していない。', null, null],
    ['known-arithmetic', '資料の件数10と20の和を30と計算し、対象を限定した。', null, null],
  ],
};
const inputs = [], labels = [];
for (const [domain, cases] of Object.entries(scenarios)) {
  cases.forEach(([family, scenario, gap, probe], i) => {
    const id = `${domain}-${String(i + 1).padStart(2, '0')}`;
    inputs.push({ id, family, domain, split: i % 2 === 0 ? 'development' : 'evaluation', synthetic: true, scenario });
    labels.push({ id, control: gap === null, requiredGap: gap, suitableProbe: probe });
  });
}
await mkdir('evaluation', { recursive: true });
await writeFile('evaluation/cases.json', `${JSON.stringify(inputs, null, 2)}\n`);
await writeFile('evaluation/annotations.json', `${JSON.stringify(labels, null, 2)}\n`);
