# Nhật ký thay đổi

Các thay đổi đáng chú ý, mới nhất ở trên cùng. Quy trình Deploy từ chối phát hành khi mục Unreleased còn trống, và đóng dấu mục đó bằng phiên bản được phát hành.

## Unreleased

- Nhật ký thay đổi trong Cài đặt > Giới thiệu liệt kê ghi chú của phiên bản đã cài đặt; ở v1.0.11 nhật ký vẫn chỉ dừng ở v1.0.10, cả trên ứng dụng desktop lẫn trang web từ xa.

- Nhật ký thay đổi có sẵn bằng mọi ngôn ngữ của ứng dụng, và sau khi cập nhật, ứng dụng hiển thị một lần những điểm mới của phiên bản đó.

- Suy luận tự động được bật theo mặc định trên các mô hình được hỗ trợ: mỗi tin nhắn và mỗi bước công cụ nhận được mức nỗ lực suy luận mà nó cần. Mô hình của tính năng này được tải xuống nền ở lần dùng đầu tiên thay vì lúc khởi động, và thẻ Tích hợp hiển thị mô hình cùng nền tảng mà nó dựa trên.

- Các liên kết tệp trong cuộc hội thoại mở cạnh cuộc hội thoại, trong bảng bên, dưới dạng tab. Một liên kết mới thay thế tab xem trước, nên các liên kết không còn chất đống thành nhiều tab; một tab được giữ lại khi bạn nhấp đúp vào nó, chọn Giữ mở hoặc chỉnh sửa tệp. Tối đa tám tab tệp được mở cùng lúc. Cài đặt > Chung > Xem trước liên kết sẽ tắt hành vi này.

- Các tệp CSV và TSV mở dưới dạng bảng có thể chỉnh sửa: sao chép và dán ô, thêm hoặc xóa hàng và cột, lưu bằng Ctrl+S, và hoàn tác hoặc làm lại bằng Ctrl+Z và Ctrl+Y.

- Các tệp PDF và Office (Word, PowerPoint, Excel) được xem trước trong bảng bên. Các trang Office mở lại tức thì, và một liên kết bắt đầu chuyển đổi tài liệu của nó ngay khi bạn trỏ vào.

- Có thể gắn sao cho các cuộc hội thoại: mục yêu thích nằm ở đầu danh sách phiên, và dấu sao xuất hiện khi bạn di chuột qua một hàng.

- Tìm kiếm tìm được văn bản trong các cuộc hội thoại trước đây. Một cuộc hội thoại đã xóa không để lại kết quả tìm kiếm nào, dù được xóa bằng cách nào.

- Cuộn lên trong lúc câu trả lời đang phát trực tiếp giữ nguyên vị trí của bạn thay vì nhảy ngược xuống cuối.

- Các hành động GitHub trong một câu trả lời được gom thành một thẻ GitHub, và vòng lặp của chỉ báo đang suy nghĩ không còn giật khi khởi động lại.

- Các tài khoản nhà cung cấp hiển thị email đăng nhập, và kết nối lại cùng một tài khoản sẽ giữ tên và lịch sử mức dùng của nó thay vì thêm một mục mới. Hộp thoại mức dùng không còn liệt kê các tài khoản đã bị ngắt kết nối.

- Một prompt được kéo từ hàng đợi về bản nháp không còn xuất hiện lại sau khi khởi động lại, và mở lại ứng dụng nhanh vẫn giữ cuộc hội thoại có thể chỉnh sửa thay vì mở ở chế độ chỉ đọc.

- Sửa lỗi bản dịch: các nhãn sai như Git trong tiếng Ý, Models trong tiếng Việt và Effort trong tiếng Trung và tiếng Nhật giờ hiển thị đúng.

- Trên giao diện web điện thoại, Enter chèn một dấu xuống dòng và nút gửi mới gửi tin.

- Memory khởi động được trên các hồ sơ Windows có tên thư mục người dùng không phải ASCII thuần.

- Các bản cập nhật bảo mật cho các phụ thuộc image-size và js-yaml (CVE-2025-71329, CVE-2026-84375).

## v1.0.11 - 2026-10-08

- Trình duyệt tích hợp hiển thị lại các trang trên màn hình Windows có tỷ lệ hiển thị trên 100%, thay vì lỗi "Browser display did not recover after the page changed" (#8). Các trang cũng theo dõi thay đổi tỷ lệ hiển thị, kể cả những tab không nằm trên màn hình vào lúc đó.

- Có thể đính kèm tệp Word, PowerPoint và Excel (.docx, .pptx, .xlsx, .xlsm) vào tin nhắn và tự động hóa, và văn bản của chúng đến được mọi mô hình. Các loại tệp không thể đính kèm giờ sẽ thông báo rõ và chèn đường dẫn tệp thay thế; tệp rỗng hoặc tệp không phải PDF thật bị từ chối kèm thông báo rõ ràng.

- PDF và hình ảnh từ trước đó trong cuộc hội thoại vẫn được gửi tới mô hình sau khi ứng dụng khởi động lại. Các mô hình không hỗ trợ PDF gốc nhận văn bản của PDF. Đọc PDF trên 100 trang sẽ trả về các trang đầu dưới dạng văn bản, còn PDF có mật khẩu hoặc không hợp lệ trả về lỗi rõ ràng thay vì làm hỏng các yêu cầu sau đó.

- Hình ảnh và tệp do công cụ MCP trả về đến được mô hình dưới dạng hình ảnh và tệp thay vì văn bản mã hóa thô; phương tiện không được hỗ trợ hoặc quá lớn sẽ được mô tả.

- Bản tóm tắt tạo khi thu gọn một cuộc hội thoại dài giờ bao gồm cả các tin nhắn dài và ghi chú các hình ảnh, tệp đính kèm.

- Các mô hình cục bộ chỉ hỗ trợ văn bản giữ lại văn bản của tài liệu đính kèm, còn hình ảnh trước đó trở thành một ghi chú ngắn thay vì làm dừng cuộc hội thoại.

- Có thể gửi phản hồi, kèm ảnh chụp màn hình tùy chọn, từ Cài đặt > Giới thiệu, và cũng có thể đọc nhật ký thay đổi tại đó.

- Các tin nhắn gần đây trong cuộc hội thoại có thể được tìm theo ý nghĩa trong truy hồi ghi nhớ ngay sau khi được lưu.

- Kết quả tìm kiếm chỉ được dùng lại khi còn mới (#7), và tìm kiếm danh sách tệp sau một tìm kiếm nội dung trả về tên tệp thay vì nội dung trước đó (#9).

## v1.0.10 - 2026-10-08

- Có thể đăng ký nhà cung cấp API tùy chỉnh trong Cài đặt với các bộ điều hợp kết nối riêng cho từng nhà cung cấp.

- Mã QR kết nối từ xa chỉ xuất hiện sau khi relay sẵn sàng, và các thẻ ghép nối cũ được xóa.

- Có thể chọn và lưu các bí danh mô hình tự động trỏ đến phiên bản mới của OpenRouter cho Main và các agent. Các bí danh mới nhất và mô hình ổn định không còn bị ẩn nhầm do tuổi danh mục, bản xem trước mới hơn hay giới hạn họ mô hình của bộ chọn mô hình.

- Khởi tạo bản vá gốc giữ cho tiến trình của nó tiếp tục chạy trong khi quá trình xác minh đang chờ, tránh thoát sớm khi khởi động trước và xác minh chồng lên nhau.

## v1.0.9 - 2026-10-07

- Hướng dẫn chung và hướng dẫn của dự án đến được mọi cuộc hội thoại mới ngay cả khi tiện ích mở rộng Ghi nhớ chưa được cài đặt hoặc đã bị tắt; công tắc đó giờ chỉ áp dụng cho các công cụ ghi nhớ và truy hồi. Lưu một hướng dẫn không còn phải chờ mô hình embedding vài giây, hướng dẫn được đưa vào đúng như đã viết mà không có id nội bộ, và tổng dung lượng có thể lên tới 32 KB.

- Đăng nhập GitHub từ Cài đặt, và mọi tính năng khác khởi chạy tiến trình terminal, hoạt động trở lại trong ứng dụng desktop đã cài đặt thay vì lỗi "posix_spawnp failed". Một tài khoản GitHub phụ cũ do gh lưu không còn khiến đăng nhập thành công bị báo "no account is signed in".

- Browser Use và Computer Use không còn yêu cầu phê duyệt trước lần gọi đầu tiên trong một phiên, và `setup set_first_use_approval` đã bị loại bỏ.

- Thẻ phê duyệt công cụ khớp với các thẻ xếp chồng phía trên ô nhập: biểu tượng cảnh báo, tiêu đề và công cụ nằm trên cùng một dòng, lý do nằm bên dưới chỉ kèm lệnh, đường dẫn hoặc URL cần phê duyệt (không có hàng thư mục hay danh sách đối số), và nút Từ chối nằm kín đáo bên cạnh nút Cho phép.

- Các mô hình mới nhận khả năng từ danh mục của nhà cung cấp thay vì chờ một bản phát hành: đổi mức nỗ lực giữa cuộc hội thoại trên tuyến ChatGPT, Fast mode và cài đặt cache trên tuyến OpenAI API, Fast mode trên Claude, và mức suy luận trên xAI. GPT-6.1 Sol và Claude Sonnet 5.5 hiện đã được hỗ trợ, và nút chuyển Fast không còn xuất hiện trên các mô hình Claude không thể dùng nó.

- Claude Sonnet 5.5 hiển thị lại các ghi chú của nó giữa các lần gọi công cụ, và các mô hình Claude Fable và Mythos có thể dùng tìm kiếm web được lưu trữ.

- Phiên bản client mà mỗi nhà cung cấp mong đợi được ghi nhớ giữa các lần chạy, nên khởi động lại hoặc khởi động ngoại tuyến không còn quay về giá trị tích hợp cũ.

- Nhiều lỗi "conversation too long" hơn từ GLM, Kimi, Qwen, MiniMax, xAI và các backend khác giờ kích hoạt thu gọn thay vì kết thúc lượt, và tình trạng Claude quá tải giữa chừng khi đang trả lời tuân theo cùng quy tắc thử lại và dự phòng như khi xảy ra ở đầu câu trả lời.

- Thông báo và lỗi không còn xếp chồng phía trên ô nhập: xác nhận lệnh gạch chéo cùng các lỗi micro, tệp đính kèm và lệnh xuất hiện dưới dạng thông báo, còn tiến trình tải giọng nói chỉ hiển thị trên thẻ của nó trong Cài đặt. Mọi lỗi giờ đều hiển thị theo cùng một cách, không có thẻ viền, và các lần tải mô hình cục bộ hiển thị thanh tiến trình toàn chiều rộng dưới hàng của chúng.

## v1.0.8 - 2026-10-05

- Ứng dụng macOS được ký bằng chứng chỉ Developer ID và được Apple công chứng, nên bản tải xuống mở được mà không có cảnh báo Gatekeeper và tính năng tự động cập nhật của macOS có thể cài các phiên bản mới. Các lời nhắc về micro và AppleScript giờ giải thích Mixdog dùng chúng để làm gì.

## v1.0.7 - 2026-10-04

- Browser Use trên điện thoại phát trực tiếp trang trên desktop thay vì làm mới ảnh chụp, và nhận cùng các kiểu nhập chuột, chạm, cuộn, bàn phím và IME như ngăn trên desktop. Khi một agent bàn giao trang (ví dụ CAPTCHA), điện thoại cũng mở trang đó.

- Hoạt động của công cụ trong bản ghi hội thoại dễ quét hơn: mỗi hàng mở đầu bằng một động từ ngắn, thao tác đọc và tìm kiếm hiển thị kết quả theo từng tệp, danh sách hiển thị các hàng tệp, lệnh nằm trong hộp riêng, đầu ra `git diff` được hiển thị dưới dạng diff, và trang mà trình duyệt đã truy cập có một thẻ để mở lại trong ngăn.

- Thông báo lượt đã hoàn tất đến sớm hơn, hiển thị văn bản thuần thay vì Markdown thô, kết thúc ở một câu trọn vẹn, và không còn bị giữ lại bởi các tác vụ shell nền chạy lâu.

- Các phiên dùng gần đây mở nhanh hơn sau khi khởi động lại và khi mở lại.

- Công cụ setup có thể quản lý tài khoản OAuth, tùy chọn nhà phát triển, các ghim trên thanh hoạt động và máy chủ MCP của plugin, và các yêu cầu từ phiên chia ngăn được xử lý. Cửa sổ tự động xóa của chính nhà cung cấp giờ ghi đè cửa sổ toàn cục.

- Công cụ Git được bật ở bất cứ nơi nào đã cài `git`, mà không cần cài tiện ích mở rộng. Lịch và webhook luôn gửi tới phiên của ứng dụng.

- Giao diện ứng dụng giữ nguyên tỷ lệ 100%, các cài đặt được lưu ở cửa sổ hoặc terminal khác được áp dụng ngay, và đường viền, biểu tượng, khoảng cách danh sách cùng hiệu ứng xuất hiện của hộp thoại nhất quán hơn.

## v1.0.6 - 2026-10-03

- Thông báo đẩy trên điện thoại giữ im lặng khi ứng dụng đang hiển thị trên màn hình, theo dõi đăng ký mà trình duyệt tự gia hạn, và công tắc tự tắt khi thông báo bị chặn trong cài đặt hệ thống.

- Ứng dụng điện thoại không còn kẹt ở màn hình tải khi quay lại sau một lần cập nhật relay; nó tải xong ngay khi desktop kết nối lại, và lần khởi chạy đầu nhanh không còn bỏ qua việc cài service worker của ứng dụng.

- Trên Android, cử chỉ quay lại đóng bảng hoặc menu đang mở mà không làm thanh điều hướng nhấp nháy.

- Các tab không gian làm việc, tiêu đề bảng bên và nút dọn dẹp của Studio gọn hơn, và tab được chọn nổi bật rõ hơn.

- Nhãn mức dùng ngắn hơn, lượng hạn mức sắp đặt lại được tính theo giờ khi còn chưa đến một ngày và không bao giờ vượt quá phần còn lại, và các bản dịch được trau chuốt trên nhiều ngôn ngữ.

## v1.0.5 - 2026-10-03

- Ứng dụng desktop có thể hiển thị thông báo của hệ điều hành, kèm âm thanh, khi một lượt kết thúc với câu trả lời cuối cùng, và thông báo dẫn trở lại phiên đó.

- Các công cụ Office soạn tài liệu docx, xlsx và pdf từ HTML thông qua một phiên trình duyệt dùng chung.

- Mức dùng hiển thị ước tính giá trị hạn mức và tổng theo từng phiên.

- Các host Browser và Computer Use bền vững hơn: biến đổi khung, quyền riêng tư hình ảnh, ảnh chụp màn hình dạng lát và khôi phục sau lỗi.

- Kiểm tra cú pháp PowerShell không còn nhầm các đoạn động từ-gạch nối bên trong đường dẫn với cmdlet.

- `adm-zip` được cập nhật lên 0.6.1 do CVE-2026-102282.

## v1.0.4 - 2026-10-01

- Bộ chọn mô hình làm mới ngay khi nhà cung cấp thay đổi. Đăng nhập OAuth qua trình duyệt (OpenAI, Grok, Cursor, Antigravity) và chuyển tài khoản giờ tải lại bộ chọn ngay lập tức thay vì sau khi khởi động lại, và nhà cung cấp được kết nối, gỡ bỏ hoặc chuyển ở một cửa sổ cũng làm mới mọi cửa sổ desktop khác và điện thoại đã ghép nối.

- Đóng cửa sổ không còn hỏi phải làm gì. Cài đặt có lựa chọn "Khi đóng cửa sổ" giữa ẩn xuống khay (mặc định) và thoát hoàn toàn, biểu tượng khay có sẵn ngay từ lúc khởi chạy, và lời nhắc xác nhận thoát trong ứng dụng đã bị loại bỏ.

- Các hàng agent của quy trình hiển thị giống nhau ở mọi nơi: hàng không ghim mô hình, kể cả Tìm kiếm web, hiển thị "Mặc định", còn tên agent và nhãn mô hình không được dịch. Các tab không gian làm việc chưa chọn nằm trên một nền mờ thay vì các đường phân cách mảnh.

- Công cụ Goal và kỹ năng goal-management mô tả Mục tiêu là danh sách tác vụ cho công việc đã được phê duyệt, thực hiện xuyên suốt nhiều lượt, và loại trừ các lịch định kỳ và các mục tiêu phải chờ hàng tuần cho các sự kiện bên ngoài.

## v1.0.3 - 2026-10-01

- Việc tạo phương tiện ghi một hàng mức dùng cho mỗi tác vụ ảnh hoặc video với số token, ảnh, giây và chi phí mà nhà cung cấp báo cáo, nên phương tiện của Gemini, Antigravity, Codex và xAI xuất hiện trong tổng mức dùng và chi phí cùng với các mô hình văn bản. Giá phương tiện lấy từ danh mục giá đã công bố.

- Dừng và Tiếp tục của Computer Use khôi phục gọn gàng sau khi dọn dẹp thất bại: các worker rảnh được cho nghỉ thay vì hết thời gian chờ, và thao tác Dừng hoặc Tiếp tục của người dùng xóa trạng thái cũ "input not confirmed released".

- Các phiên đang chờ tác vụ shell nền hiển thị là đang chờ thay vì rảnh, và chỉ báo tác vụ shell không còn hiển thị tác vụ của chủ sở hữu trước hoặc mất các cập nhật đến trong lúc thăm dò. Danh sách phiên và agent bỏ qua các lần vẽ lại dư thừa khi không có gì thay đổi. Biểu đồ mức dùng, các trang trên thanh, tab không gian làm việc, danh sách tiện ích mở rộng và hộp thoại có giao diện được làm mới.

- Các lần quét grep và read đồng thời giống hệt nhau dùng chung một lần quét gốc, kết quả được lưu đệm bị vô hiệu theo từng đường dẫn sau khi chỉnh sửa, và một bản vá bị hủy sẽ dừng trước khi ghi thêm tệp. Tìm kiếm code graph khớp đường dẫn Windows bất kể chữ hoa chữ thường, dấu phân cách, tiền tố verbatim (`\\?\`) và UNC. Hook pre-tool bị lỗi giờ chặn công cụ thay vì để nó chạy.

- Kỹ năng browser giữ các trang ở chế độ nền trừ khi chính trang đó là sản phẩm bàn giao hoặc người dùng phải thao tác trên đó. Phát triển desktop (`npm run dev`) và các script E2E trực tiếp trên Windows chạy trong một hồ sơ cô lập mới trên cổng CDP `9342`.

## v1.0.2 - 2026-10-01

- Các nút sao chép trong bản ghi hội thoại có thể ghi vào clipboard từ cửa sổ desktop đáng tin cậy. Văn bản phản hồi, khối mã, đầu ra công cụ và diff theo từng tệp có phạm vi kiểm thử hồi quy cho văn bản được sao chép chính xác, các lần thử lại và nội dung thay đổi; việc đọc clipboard và quyền của các cửa sổ khác vẫn bị chặn.

- Các lệnh model và effort mở bộ chọn mô hình của cuộc hội thoại hiện tại, và các agent bị tắt giữ mô hình đã chọn cho chúng. Hướng dẫn khởi đầu giải thích khuyến nghị mô hình Maintainer, và chẩn đoán giờ bao gồm nhà cung cấp cục bộ, tính năng tích hợp, giọng nói và plugin bị thiếu hoặc không hợp lệ.

- Liên kết tệp trên Windows xử lý được dấu phân cách đã mã hóa và đường dẫn có khoảng trắng hoặc chữ Hàn. Một đề cập tệp lỗi ở lần tra cứu đầu có thể được nhấp để thử lại. Chọn tất cả của Studio bao gồm mọi mục trong tab, không chỉ các trang đã tải.

- Computer Use giữ các tham chiếu chụp khớp với các lần đọc lại khả năng truy cập, chỉ gắn lại an toàn các điều khiển được dựng lại khi danh tính quan sát được khớp, và chờ khi desktop nhập liệu bị khóa thay vì coi khóa là lỗi của bộ quan sát.

- Các tab không gian làm việc và hướng dẫn khởi đầu có kiểu dáng rõ ràng hơn, thanh bên phiên mở sẵn khi khởi động, và các nhóm công cụ không còn hiển thị huy hiệu lỗi tổng hợp. Văn bản hướng dẫn dự án không còn được thêm vào khối môi trường của system prompt. Các gói đã xuất bản loại trừ các bài kiểm thử phát triển lồng nhau.

## v1.0.1 - 2026-09-30

- Ứng dụng desktop trên Windows 11 giờ nằm trong khung cửa sổ Mica với lớp vỏ đơn sắc dịu hơn: cửa sổ bật lên và bảng được tách bằng bóng đổ thay vì đường viền, vùng chọn không còn chuyển sang màu xanh, và màu nhấn được dành cho trạng thái đang hoạt động. Văn bản theo một thang cỡ chữ duy nhất (chú thích 12px đến tiêu đề trang 20px và các số liệu nổi bật), tab được chọn là một thẻ nổi, các nút phá hủy giữ trung tính cho đến khi di chuột qua, và các biểu đồ mức dùng và ngữ cảnh dùng chung một bảng màu.

- Đóng cửa sổ sẽ hỏi một lần là giữ Mixdog chạy trong khay hay thoát hoàn toàn, và ghi nhớ câu trả lời. Thoát trong khi một agent vẫn đang làm việc sẽ hỏi mỗi lần.

- Mức dùng gói đăng ký hiển thị tỷ lệ của từng mô hình dưới dạng vùng xếp chồng bên dưới đường tổng, và thẻ khi di chuột của nó chỉ đi theo con trỏ bên trong biểu đồ.

- Cuộc hội thoại luôn bám vào tin nhắn mới nhất khi một thẻ đổi chiều cao trong lúc cuộn. Các tệp SVG mà agent viết xuất hiện dưới dạng kết quả hình ảnh và mở trong trình xem của hệ thống, và các agent bàn giao công việc trực quan như SVG hoặc trang HTML dưới dạng tệp đã lưu thay vì dán mã nguồn của chúng.

## v1.0.0 - 2026-09-30

- Ghi nhớ không còn bị hỏng do việc dựng lại runtime. Runtime ghi nhớ được dựng lại sẽ được xuất bản dưới một thẻ phát hành mới thay vì thay thế các tệp mà ứng dụng đã cài đặt xác minh, runtime mới được cài bên cạnh runtime đang dùng thay vì xóa nó trong khi PostgreSQL vẫn chạy từ đó, và hai tiến trình cài đặt cùng lúc không còn xóa bản tải xuống của nhau. Các bản triển khai phát triển cục bộ từ chối chạy từ một nhánh nằm sau nhánh upstream của nó.

- Thẻ công cụ không còn đánh dấu các lệnh gọi đã xong là thất bại. Một lệnh có đầu ra chứa dòng `status:`, một `git diff --quiet` hoặc `git grep` báo có khác biệt hoặc không khớp, một tra cứu code_graph không tìm thấy ký hiệu, và việc phân trang các kết quả tidy đã lưu giờ hiển thị là đã hoàn tất; một lệnh git thoát với mã khác 0 hiển thị là thoát, giống shell; và một lệnh browser hoặc computer bị dừng vì người dùng giành quyền điều khiển hiển thị là đã hủy.

- Ít lệnh gọi công cụ thất bại hơn do sai sót đối số ở lần thử đầu: công cụ git thêm `git` đứng đầu còn thiếu, read khai báo giới hạn 10 mục tiêu trong schema của nó, và một Goal đầy các tác vụ đã hoàn thành cho biết cách dành chỗ cho tác vụ mới. Nhật ký lỗi giờ ghi lại các mục tiêu read và kích thước đầy đủ của các lô đường dẫn.

- Các yêu cầu được tính giá theo bậc mà chúng thực sự được gửi: yêu cầu Fast và Priority dùng giá đã công bố, yêu cầu Fast được thử lại ở chế độ tiêu chuẩn được tính như tiêu chuẩn, và các biến thể Fast của Cursor được tính như mô hình trong danh mục của chúng. Bật tắt Fast cập nhật dòng trạng thái ngay lập tức.

- Các quy tắc xác thực dữ liệu của Excel được kiểm tra trước khi tạo sổ làm việc, nên loại quy tắc không xác định hoặc thiếu giới hạn sẽ thất bại ngay từ đầu trên cả hai backend. Vệt sáng hoạt động trực tiếp là một dải ngắn hơn, nhạt hơn, và tên tóm tắt công cụ dùng độ đậm vừa.

## v0.9.175 - 2026-09-29

- Các agent Claude giờ giữ cache hội thoại trong 5 phút thay vì một giờ. Khi yêu cầu tiếp theo của agent đến sau khi cache đó hết hạn — sau một lần build hoặc kiểm thử dài, hoặc khi một agent đã xong được tiếp tục — nó thu gọn cuộc hội thoại trước, để yêu cầu ghi lại cuộc hội thoại đã thu gọn thay vì mọi thứ agent đã tích lũy. Trong một lần phát lại mức dùng agent Claude gần đây, điều này giảm chi phí token của agent khoảng một phần tư. Các phiên Lead không thay đổi.

- Nhiều phiên chạy song song không còn làm chậm nhau. Tin nhắn đang chờ được giữ theo từng phiên, tóm tắt phiên và mức dùng gateway được nối thêm thay vì ghi lại, bản ghi hội thoại đã lưu được phân tích ngoài vòng lặp chính, và một chu kỳ ghi nhớ bị lỗi sẽ giãn cách thay vì thử lại dồn dập. Khi daemon thoát, nó ghi lại lý do. Máy chủ phiên đa tiến trình riêng biệt đã bị loại bỏ; các phiên chạy ngay trong daemon.

- Mức dùng gói đăng ký được ghi trước khi chuyển tài khoản giờ được tính cho tài khoản đang dùng khi bắt đầu ghi. Grok, Claude và Cursor báo phiên bản client hiện tại của chúng thay vì giá trị cố định.

- Ứng dụng desktop không còn hiển thị một phiên trống khi daemon gửi nội dung ngay sau khi trả lời yêu cầu mở. Script khởi động của ứng dụng đóng gói được chính sách bảo mật nội dung cho phép, và việc kiểm tra gốc dự án, lỗi điều phối relay và khôi phục phiên trình duyệt đã được sửa.

- Sổ làm việc và tài liệu được chỉnh sửa không cần Office: xóa một ô trống không còn xóa ô đứng sau nó, xóa một bình luận tìm được các bình luận có định dạng tác giả, các phần liên kết bằng đường dẫn tuyệt đối được phân giải, và văn bản trông giống mẫu thay thế được chèn nguyên văn.

- Các runtime tải xuống (PostgreSQL, pgvector, phông chữ, FFmpeg) được kiểm tra theo checksum đã ghim trước khi dùng. Các công cụ gốc sửa lỗi phân tích window-id có thể cắt đôi một ký tự nhiều byte, một phép tính thời gian có thể tràn số, và việc thay thế snapshot có thể để lại tệp dở dang.

## v0.9.174 - 2026-09-29

- Hộp thoại mức dùng giờ trả lời thêm một câu hỏi: hạn mức của gói đăng ký đã được dùng hết như thế nào. Bên cạnh mức dùng token, một tab Mức dùng gói đăng ký theo dõi các cửa sổ giới hạn riêng của từng nhà cung cấp — Codex, Claude, Grok, Cursor, Antigravity và OpenCode Go — khi chúng tăng và đặt lại, cùng với các mô hình làm đồng hồ nhích lên và lịch sử các cửa sổ trước đó. Mixdog ghi lại mọi số đọc hạn mức mà nó đo được; mức tăng không có yêu cầu Mixdog nào đứng sau được hiển thị là mức dùng từ bên ngoài Mixdog, chẳng hạn ứng dụng web của nhà cung cấp. Đồng hồ nhà cung cấp trong bảng mức dùng mở thẳng gói đăng ký của chính nó.

- `/doctor` cũng hoạt động trong ứng dụng desktop, dưới dạng hộp thoại (cũng có tại Cài đặt → Hệ thống → Doctor). Nó chạy cùng các kiểm tra sức khỏe chỉ đọc như TUI, tất cả cùng lúc với thời hạn cho mỗi kiểm tra để một kiểm tra bị treo không thể che các kiểm tra khác, và mọi cảnh báo hay lỗi đều nêu cách khắc phục.

- Các bản trình bày PowerPoint mới được thiết kế bằng HTML. Mô hình bố cục từng slide bằng HTML và CSS, Chrome hoặc Edge cục bộ kết xuất nó, và `author` biến những gì trình duyệt đã vẽ thành các đối tượng PowerPoint gốc, có thể chỉnh sửa: hộp văn bản giữ nguyên ngắt dòng của trình duyệt, hình dạng, đường kẻ, bảng, biểu đồ và hình ảnh. Văn bản tiếng Hàn ngắt đúng chỗ người đọc mong đợi, một bước kiểm tra hình học từ chối các slide có căn chỉnh đã khai báo mà trình duyệt không thể xác nhận, và `render` hiển thị từng trang HTML cạnh bản kết xuất PowerPoint của nó. Lộ trình script vẫn được giữ cho các bản trình bày muốn dùng các thiết bị đã đo của bộ công cụ, hoặc khi không có trình duyệt cục bộ.

- Chèn hoặc xóa hàng và cột trong sổ làm việc không cần Excel giờ ghi lại mọi thứ có nhắc đến các ô đó, giống như Excel: công thức trên mọi trang tính, tên đã định nghĩa và vùng in, định dạng có điều kiện, xác thực dữ liệu, chuỗi dữ liệu biểu đồ, nguồn pivot, bộ lọc, liên kết, ô hợp nhất, bảng và hình vẽ. Trước đây các ô bị di chuyển trong khi tham chiếu vẫn giữ nguyên, nên tổng của báo cáo vẫn cộng vùng cũ và hiển thị 72,200 trong khi Excel hiển thị 74,700. Một chỉnh sửa có tham chiếu không thể ghi lại sẽ bị từ chối, kèm danh sách, trước khi có bất kỳ thay đổi nào.

- PDF và các dải bảng tính được dàn trang giữ ngày, giờ, phân số và số tiền kiểu Hàn trên một dòng. "10월 14일", "14시 30분", "3분의 1", "12만 6천 원" và "24억 원" không còn bị ngắt giữa chừng, điều từng làm ngày quyết định hay khoản tiết kiệm bị tách sang hai dòng.

- Các tệp Office cho ra kết quả giống nhau dù do Microsoft Office hay trình ghi di động tích hợp tạo ra. Một lần so sánh song song dài của cả hai đã căn chỉnh khoảng cách Word, chế độ tương thích và bảng; Excel autofit, thụt lề, đường viền, thiết lập in và biểu đồ dựng sẵn; PowerPoint ngắt dòng tiếng Hàn, phông chữ Đông Á, chân trang, cắt ảnh bìa, bóng đổ và độ trong suốt; và căn chỉnh PDF cùng độ rộng bảng. Các kiểm tra rà soát báo cáo cùng các vấn đề trên cả hai backend, biểu đồ Excel có thể đọc vùng của trang tính khác, và `set_chart_data` giữ liên kết và tên chuỗi của biểu đồ.

- Computer Use chạy trên macOS và Linux. Các bản dựng desktop cho các hệ thống đó đi kèm một backend gốc nói cùng giao thức với host Windows và áp dụng cùng danh sách hành động và giới hạn. Một chuỗi giờ cũng có thể tác động lên nhiều phần tử của một lần quan sát: mỗi bước sau chứng minh lại phần tử của nó với cây khả năng truy cập đang chạy, và chuỗi dừng khi chuyển cửa sổ, khi có lỗi, hoặc khi gặp phần tử bị vô hiệu hóa hay nằm ngoài màn hình.

- Ứng dụng điện thoại mở và kết nối lại nhanh hơn và truyền ít dữ liệu hơn nhiều. Bản ghi hội thoại hiển thị ngay sau lần đồng bộ đầu tiên, các lần kết nối lại ngắn tiếp tục bằng delta thay vì đồng bộ lại toàn bộ, điện thoại chỉ phản chiếu tab mà nó đang hiển thị, bản xem lại lượt đã thu gọn đọc tên tệp và số lượng mà không cần văn bản bản vá, và các tìm kiếm dự án chậm không còn giữ chân các lệnh gọi khác. Ứng dụng điện thoại được mở sẵn sẽ kiểm tra bản triển khai mới khi quay lại nền trước, và áp dụng một bản ngay cả khi đang ngoài màn hình hoặc giữa lượt.

- Daemon dùng ít bộ nhớ hơn và ít bị treo hơn: các phiên chỉ lưu những gì đã thay đổi, sổ cái mức dùng chạy ngoài luồng chính, khóa tệp và các lệnh gọi git không còn chặn nó, và bản ghi hội thoại dài được nạp theo từng bước 1 MB. Desktop và điện thoại kết xuất Markdown đang phát và cuộn cảm ứng với ít lần bố cục hơn, và bản ghi hội thoại của ứng dụng web không còn giật khi các hàng đang được đo.

- Nhập bằng giọng nói cho biết nó đang chuẩn bị cho đến khi việc thu thực sự bắt đầu, khởi động sẵn việc phiên âm trong khi bạn nói, và phiên âm nhanh hơn mà không chặn ứng dụng.

- Kết quả công cụ tốn ít token của mô hình hơn. `read` trả về các hàng mà không có số dòng — TUI và desktop vẫn vẽ phần lề — giúp giảm khoảng 16% token trên các phiên đã ghi; thông báo shell và tác vụ ngắn hơn; và các chỉnh sửa báo đường dẫn tương đối so với thư mục làm việc.

- Thu gọn mang theo ít tài liệu cũ hơn trong các cửa sổ ngữ cảnh lớn. Phần hội thoại nguyên văn và lịch sử công cụ gần đây được giữ lại qua một lần Thu gọn bị giới hạn ở 20,000 token thay vì tăng theo cửa sổ. Ảnh chụp trình duyệt hoặc quan sát desktop bị một lần sau của cùng trang hay cửa sổ thay thế chỉ giữ kết quả và một con trỏ tới bản gốc đã lưu trữ, và các câu trả lời cũ hơn bỏ phần phát lại mờ đục của nhà cung cấp trong khi vẫn giữ các lệnh gọi và kết quả công cụ.

- Một nhà cung cấp tạm thời không khả dụng không còn kết thúc lượt ngay khi các lần thử lại của chính nó hết. Khi chưa có gì xuất hiện trên màn hình, lượt chờ thêm vài chu kỳ khôi phục, từ 15 giây đến một phút, và tuân theo Retry-After của chính máy chủ. Khi luồng bị cắt trong lúc đối số của một lệnh gọi công cụ vẫn đang đến, lệnh gọi đó không được chạy, và mô hình được bảo hãy chia nội dung thành các lệnh gọi nhỏ hơn thay vì gửi lại toàn bộ.

- OAuth của Cursor và Antigravity (Gemini) là các công tắc riêng trong Cài đặt → Nhà phát triển, và mỗi cái chỉ bật sau khi bạn xác nhận rủi ro bị hạn chế tài khoản khi dùng nhà cung cấp đó qua OAuth. Biến môi trường `MIXDOG_DEV_PROVIDERS` không còn bật chúng.

- Cuộc hội thoại không còn nhảy khi các thanh phía trên ô soạn thảo mở hoặc đóng: chúng trượt qua chuyển động thay vì dịch bản ghi hội thoại toàn bộ chiều cao của chúng cùng lúc, và mở một phiên không còn nháy lên số lượng xem lại lượt rồi biến mất ngay sau đó.

- Đổi tên tệp hoặc thư mục trong trình khám phá giữ các tab trình soạn thảo đang mở trên đường dẫn mới. Tệp có chỉnh sửa chưa lưu bị từ chối cho đến khi được lưu, vì bộ đệm của nó thuộc về đường dẫn cũ.

- Studio dọn dẹp hàng loạt: các mục đã chọn, mọi thứ trước một ngày, các mục có tệp đã mất, hoặc toàn bộ một loại. Cài đặt → Giới thiệu liệt kê một địa chỉ hỗ trợ kèm nút Sao chép và Email, và hộp thoại Clear browsing data của trình duyệt tích hợp đã bị loại bỏ.

- Một lượt mục tiêu tự động không gọi công cụ nào giờ sẽ chờ thay vì nhắc lại.

## v0.9.173 - 2026-09-22

- Tin nhắn trong hàng đợi được khôi phục giữ văn bản mà daemon đã xác nhận. Khôi phục một tin nhắn sẽ công bố hai lần trong cùng một nhịp — phỏng đoán cục bộ trước, câu trả lời của daemon một lát sau — và cả hai đều được đóng dấu bằng đồng hồ. Khi chúng rơi vào cùng một mili giây, ô nhắc coi cái thứ hai là cái thứ nhất và giữ phỏng đoán, nên một tin nhắn đã chỉnh sửa có thể quay lại sai lệch tinh vi. Ô nhắc giờ theo chính văn bản, không chỉ theo dấu thời gian.

- Nhảy hai lần trong cùng một khoảnh khắc không còn làm mất lần nhảy thứ hai. Hai yêu cầu "đi tới dòng này" trong cùng một mili giây mang cùng một dấu thời gian, và trình soạn thảo chỉ đọc dấu thời gian, nên yêu cầu thứ hai bị bỏ và con trỏ nằm ở dòng đầu.

- Một tìm kiếm bị sập không còn kéo sập cả công cụ tìm kiếm. Công cụ vốn đã biết cách trả lời một yêu cầu lỗi bằng một lỗi và tiếp tục phục vụ, nhưng bản dựng phát hành được biên dịch sao cho bất kỳ sự cố nào cũng giết tiến trình — làm mất mọi tìm kiếm khác đang chạy và chỉ mục tệp đã khởi động. Giờ nó vẫn sống sót, trả lời yêu cầu đó bằng một lỗi, và giữ các cache của mình. Nếu sự cố xảy ra khi đang thu thập tệp, các đường dẫn đã thu thập vẫn được công bố thay vì lặng lẽ biến mất khỏi câu trả lời.

- Áp dụng và Xóa trên một hàng nhà cung cấp cục bộ nằm trên cùng một dòng. Chúng lệch nhau hai pixel vì hàng trộn một ô nhập cao hơn với một nút thấp hơn.

- Dọn dẹp mã cho bạn biết khi một công cụ không phải là công cụ bạn nghĩ. Nếu một formatter hoặc linter cùng tên có thể truy cập trên máy bạn nhưng không phải cái Mixdog chạy, báo cáo giờ nêu tên cả hai, kèm phiên bản — chạy tệp nhị phân khác đó không nói lên điều gì về kết quả bạn được hiển thị. Một lần dọn dẹp cũng tách các phát hiện trong những tệp bạn đã chạm vào khỏi các phát hiện trong những tệp chưa bị động tới trong kho, nên áp dụng các bản sửa cho cả thư mục không còn ghi lại các tệp bạn không định thay đổi.

- Cập nhật ứng dụng đã cài không còn dừng lại vì phần mềm diệt virus đã xóa một tệp mà bản cập nhật vốn sẽ bỏ. Việc chuẩn bị giải nén toàn bộ ứng dụng đã cài và xóa phần sắp được thay thế; một tài sản renderer bị cách ly là đủ để hủy bản triển khai.

## v0.9.172 - 2026-09-21

- Một trang không còn mở ra bằng cách thông báo những lượt tải xuống mà nó chưa từng thực hiện. Các tệp đã lưu thuộc về phiên, nhưng mỗi trang theo dõi những gì nó đã báo cáo từ con số không, nên mọi trang mở sau đó đều chào người gọi bằng toàn bộ phần tồn đọng — một trang tìm kiếm báo cáo một tệp mà tab khác đã lưu vài phút trước. Một trang mới bắt đầu với hiểu biết về những gì đã xảy ra trước khi nó tồn tại; một tệp được lưu trong khi nó đang mở vẫn đến được với nó.

- Lỗi của chính trình duyệt không còn bị hiểu là lỗi của trang. Một lệnh gọi CDP hết thời gian, một khung con không thể gắn vào, một lần chặn bắt không thể trả lời — tất cả đều bị ghi thành lỗi console của trang, nên phản hồi về một trang web bình thường có thể mở đầu bằng `CDP Runtime.evaluate timed out` như thể trang đã ghi nó. Chúng vẫn đọc được qua `console`, được đánh dấu `[browser]`, và không còn được tính vào các lỗi mà trang phải chịu trách nhiệm.

- Hạn chót bị chạm khi đang có hộp thoại mở sẽ nói rõ điều đó. Một alert, confirm hoặc prompt làm treo luồng chính của trang, nên lệnh gọi tiếp theo chết vì hết thời gian mà chỉ có hạn chót — và lần thử lại hiển nhiên cũng hết thời gian y như vậy. Lỗi giờ nêu tên hộp thoại và nội dung của nó, và nói hãy trả lời nó bằng `handle_dialog` trước khi tác động lên trang trở lại.

- Việc đổi route phía client được trả lời bằng màn hình mà nó tạo ra, không phải màn hình mà người gọi đã rời đi. Các ứng dụng một trang đổi địa chỉ bằng `history.pushState` và kết xuất giao diện mới một lát sau; không có tài liệu nào được tải, nên bước chờ ổn định thấy một trang yên tĩnh và trả về ngay — và một `expect.url` được thỏa mãn bởi địa chỉ mới trước khi có gì được vẽ. Nhấp "Learn" trên react.dev trả lời bằng trang chủ dưới địa chỉ `/learn`. Khi một hành động đổi địa chỉ mà không tải, phản hồi giờ chờ trang yên tĩnh trở lại và điều kiện URL không được cắt ngang việc đó. Đo trên bộ kiểm thử thiết bị thật: độ trễ của navigate, click và snapshot không đổi, vì chỉ các lần đổi route trong cùng tài liệu mới phải chờ thêm.

- Chi tiết WebSocket hiển thị yêu cầu nâng cấp mà nó thực sự đã gửi. Trước đây chỉ ghi địa chỉ và phản hồi bắt tay, nên `network` trả lời bằng phần header yêu cầu trống — mà một lần nâng cấp bị từ chối thường được giải thích bởi `Origin`, `Sec-WebSocket-Protocol` hoặc một cookie. Thông tin xác thực vẫn bị che.

- Một cú nhấp mở ra một tab không còn bị báo là cú nhấp không làm gì. Một liên kết `target="_blank"` để nguyên tài liệu hiện tại, nên phản hồi trả lời "No observable change" và bảo người gọi tìm phần tử che phủ — trong khi trang vừa mở nằm trong `list_tabs` mà không được nhắc tới. Phản hồi giờ nêu tên trang đã mở và cách thao tác trên nó.

- `drag` nhận các mục tiêu không cần snapshot như mọi thao tác con trỏ khác. Hai đầu của nó trước đây chỉ nhận ref hoặc tọa độ thô, mà các phần tử trang cho phép kéo — thẻ, hàng danh sách, vùng thả — thường không có tên truy cập được và do đó không có ref, nên di chuyển một cái phải dựa trên snapshot trực quan ngay cả khi đã biết bộ chọn CSS. `target` và `dropTarget` giờ gọi tên hai đầu, được phân giải cùng nhau trong một lần quan sát; ref và tọa độ hoạt động như trước, và cả hai đầu vẫn phải được chỉ định theo cùng một cách.

- Một tệp đã lưu không còn bị thông báo là một yêu cầu thất bại. Một địa chỉ chuyển thành lượt tải xuống sẽ hủy chính lần điều hướng của nó, và Chromium báo việc hủy đó là `net::ERR_ABORTED`, nên phản hồi liệt kê lượt tải xuống cũng liệt kê nó như một lỗi mạng gần đây. Các yêu cầu bị hủy — lượt tải xuống, fetch mà trang bỏ dở, điều hướng bị thay bằng cái khác — vẫn đọc được qua `network` nhưng không còn được tự nêu như lỗi của trang; một yêu cầu thực sự thất bại vẫn được nêu.

- Phản hồi `brief` không còn biến một trường đã điền thành thay đổi toàn trang. Nó so sánh với lần quan sát trước của người gọi, và khi lần quan sát đó bị giới hạn hoặc lọc thì nó chưa từng báo phần còn lại của trang — nên mọi phần tử nằm ngoài đều bị liệt kê là "changed or new". Điền ba ô trong một biểu mẫu trả lời bằng mười lăm phần tử, và gõ một từ tìm kiếm trả lời bằng một trăm bốn mươi sáu. Phản hồi giờ tách những gì hành động đã thay đổi một cách chứng minh được khỏi những gì lần quan sát trước đơn giản là chưa bao phủ, và nói lần quan sát đó chứa bao nhiêu phần của trang. Cả hai cách đều không bỏ sót gì.

- Header yêu cầu trong `network` là những header thực sự đã được gửi. Chromium báo một tập tạm thời trước rồi thêm ngôn ngữ, mã hóa, client hint và cookie sau đó, nên chi tiết yêu cầu có thể chỉ hiển thị hai header và trông như thể trang chưa từng yêu cầu nội dung tiếng Hàn. Tập sau được gộp vào; thông tin xác thực vẫn được nêu tên và không bao giờ hiển thị. Tên header không phân biệt chữ hoa chữ thường và hai báo cáo viết chúng khác nhau, nên việc gộp giữ một mục cho mỗi header — cách viết và giá trị đã đi qua đường truyền — thay vì liệt kê `User-Agent` và `user-agent` như thể yêu cầu mang cả hai.

- Các trang web thấy Browser Use là bản dựng Chrome đang kết xuất chúng. Chuỗi agent vẫn mang phiên bản ứng dụng desktop và runtime Electron, trong khi client hint mà cùng các trang đó nhận chỉ nêu Chromium; GitHub đáp lại mâu thuẫn đó bằng một bức tường đăng nhập trên một kho công khai. Phân vùng trình duyệt giờ trình bày chuỗi Chrome thuần — bớt một dấu vân tay, và ít đường vòng "unsupported browser" hơn — và user agent giả lập vẫn được ưu tiên khi một tác vụ yêu cầu.

- Các trang liên tục gắn khung lại có thể được quan sát. Các cổng thông tin và trang nhất báo mở các ô quảng cáo và widget theo từng đợt, và một snapshot bắt đầu giữa đợt từng bỏ cuộc với "frame topology changed during observation" — lặp lại được, ở lần thử thứ nhất và thứ hai. Quan sát không có tác dụng phụ, nên bộ thu thập giờ chờ một lát cho đợt đó lắng xuống và đọc lại, tới một ngưỡng nhỏ, thay vì đưa người gọi một lỗi cho một trang chỉ đang bận. Khi việc đọc vẫn thất bại, phản hồi giờ nói trang đã tải và chỉ việc đọc nó thất bại, nên bước tiếp theo là quan sát lại thay vì bỏ một trang vẫn ổn.

- Một trang chỉ báo cáo lỗi của chính nó. Các yêu cầu và lỗi console từ tài liệu trước vẫn nằm trong sổ ghi, nên snapshot của một trang bình thường có thể liệt kê các yêu cầu bị hủy từ trang web đã truy cập trước đó, và `console` trên một trang sạch có thể trả lời bằng lỗi của trang trước — cả hai đều đưa người đọc đi tìm một lỗi không tồn tại. Tải một tài liệu mới sẽ xóa chúng; điều hướng trong cùng tài liệu giữ lại, vì không có gì được tải lại.

- Các race hiển thị của Browser Use không còn là lỗi. Một lần chụp thua một lần điều hướng hoặc đổi kích thước cửa sổ giờ trả lời bằng dấu hiệu lấy mẫu lại thay vì một lỗi, vì ngăn luôn sẽ yêu cầu lại bất cứ thứ gì trang hiển thị tiếp theo. Duyệt web bình thường từng làm đầy nhật ký ứng dụng bằng các lỗi chụp — mười bảy lỗi trong một lần chạy bộ kiểm thử, giờ là không — và điện thoại đã ghép nối báo cùng race đó là "could not connect to browser screen"; giờ nó lấy mẫu lại theo nhịp đang hoạt động và chỉ báo cáo khi màn hình thực sự ngừng tiến triển.

- Xóa dữ liệu duyệt web của Browser Use. Ngăn trình duyệt có một nút cục tẩy xóa cache, dữ liệu mà các trang lưu trên thiết bị này và cookie, mỗi thứ là một quyết định riêng: cache được chọn sẵn vì mất nó chỉ tốn một lần tải lại chậm hơn, còn cookie khiến bạn bị đăng xuất khỏi mọi trang và không bao giờ là mặc định. Mỗi phạm vi được xóa riêng, nên một lỗi được báo là lỗi thay vì biến mất sau các phạm vi đã thành công. Xóa cookie cũng ghi lại tệp được niêm phong mang các phiên đăng nhập qua các lần khởi động lại, nên một lần đăng nhập bạn đã xóa không quay lại vào lần mở ứng dụng tiếp theo — và nếu không thể ghi lại tệp đó, cookie được báo là chưa xóa thay vì đã xong. Trước đây phân vùng dùng chung phình to trên đĩa mà không có cách thu hồi.

- Các chỉ số `performance` của Browser Use báo bộ nhớ của tiến trình vẽ trang, không chỉ heap JavaScript: một trang có hình ảnh và lớp chiếm nhiều bộ nhớ từng trông nhỏ. Kết quả đọc nêu tên tiến trình, vì một renderer có thể vẽ nhiều trang của cùng một trang web.

- Chính sách miền của Browser Use bao gồm cả kết nối ngang hàng. Khi người vận hành hạn chế các miền mà một trang được truy cập, WebRTC không còn vượt qua bộ lọc qua STUN và TURN: kết nối ngang hàng bị từ chối trong trang và trong mọi khung con. Khi không có chính sách miền thì không có gì thay đổi, và đây vẫn là sự kiềm chế đối với mã của trang chứ không phải ranh giới mạng.

- Ảnh chụp màn hình phần tử của Browser Use. `snapshot mode=visual` nhận `ref` hoặc `target` và trả về phần tử đó thành một hình ảnh riêng. Hộp được đo bằng pixel CSS của tài liệu trên cùng — các khung cùng tiến trình gộp độ lệch của chúng ở phía trang, một khung khác nguồn cộng độ lệch phiên của nó mà không có hit test bảo vệ đầu vào, vì một bức ảnh không gửi gì và một khung dưới phép biến đổi CSS vẫn xứng đáng có một bức — và vùng cắt được co giãn theo tỷ lệ ảnh trên viewport, nên đúng trên màn hình phóng to hoặc DPI cao. Một phần tử cao hoặc rộng hơn cửa sổ được cắt ra từ ảnh chụp tài liệu thay vì viewport, nên một bảng hay bài viết dài đến nguyên vẹn thay vì dừng ở mép màn hình; chỉ một trang quá lớn để chụp mới quay về phần nhìn thấy, và nói rõ điều đó. Hình ảnh chỉ dùng để kiểm tra: nó không bao giờ được gắn làm căn cứ tọa độ, vì ref vẫn là cách để tác động lên phần tử. `mode=semantic`, `fullPage` và `format=pdf` từ chối một target thay vì bỏ qua nó.

- Độ trung thực đầu vào của Browser Use. `drag` giờ hoàn tất thao tác kéo HTML5 của chính trang: cơ chế chặn kéo của Chromium trao dữ liệu mà trang đã bắt đầu và cử chỉ kết thúc bằng `dragEnter`/`dragOver`/`drop`, thứ mà thẻ kanban, danh sách sắp xếp được hay vùng thả tệp thực sự lắng nghe; các trang chỉ theo dõi sự kiện chuột giữ đường dẫn cũ. `type` gửi một sự kiện phím thật cho mỗi ký tự thay vì chèn cả chuỗi, nên tự động hoàn thành theo phím gõ và combo box phản ứng được, trong khi các ký tự ngoài bố cục US (tiếng Hàn, emoji) vẫn được chèn dưới dạng văn bản. `press` gửi mã phím US cho dấu câu (`.` từng là Delete, `-` từng là Insert), không để một phím tắt gõ ra ký tự, và không còn suy ra Shift từ chữ hoa, điều từng biến `Control+A` thành `Control+Shift+A`. `upload` thả tệp lên một phần tử không bao giờ mở hộp chọn tệp, kèm một cơ chế bảo vệ vô hiệu hóa thao tác thả không được xử lý — nếu không trình duyệt sẽ điều hướng trang tới tệp được thả — và báo rõ ràng khi không có gì chấp nhận nó.

- Độ trung thực quan sát của Browser Use. `scroll text=` tìm trong các khung và shadow root như `read` và `expect`, chọn một kết quả khớp trong số đó, và không còn cuộn tới một phần tử đã thu gọn. `expect.text` chuẩn hóa khoảng trắng trong một dòng nhưng giữ ngắt dòng, nên đánh dấu thụt lề khớp được trong khi hai khối riêng biệt không bao giờ gộp thành một câu. Chẩn đoán console giữ những gì trang đã ghi: đối số đối tượng đến dưới dạng bản xem trước đọc được thay vì thông điệp trống, các mục nêu tên script và dòng mà người đọc sẽ mở, và một `throw` trần không bắt được mang theo vị trí của nó. Snapshot đánh dấu `aria-hidden`, một `select` gốc thất bại liệt kê các tùy chọn mà nó tìm thấy, và `aria-labelledby` được phân giải bên trong shadow root.

- Browser Use đếm những chẩn đoán mà nó không thể chứa hết. Báo cáo trang hiển thị ba lỗi console và lỗi mạng mới nhất, trông như toàn bộ câu chuyện: mười hai lỗi đến chỉ còn ba. Báo cáo giờ nêu tổng số và chỉ tới `console` hoặc `network` mỗi khi danh sách bị giới hạn.

- Browser Use thừa nhận khi đoạn trích của trang dừng sớm. Văn bản nhìn thấy trong snapshot bị giới hạn, và báo cáo chỉ nói "condensed", nên một bài viết dài đọc như thể đoạn trích là toàn bộ trang. Cả hai đường snapshot — chụp khả năng truy cập và dự phòng DOM — giờ đánh dấu một đoạn trích bị cắt, và báo cáo nêu nó chứa bao nhiêu và nói rằng trang còn nhiều hơn.

- Tệp đính kèm báo kích thước của hình ảnh mà chúng thực sự tạo ra. Việc vừa khít một hình ảnh vào ngân sách patch thị giác cắt từng cạnh một, có thể yêu cầu một hộp mà bức ảnh không lấp đầy; bản kết xuất khi đó nhỏ hơn kích thước được báo bên cạnh, và các tọa độ ánh xạ qua kích thước đó bị lệch. Việc đổi kích thước giờ báo kích thước của hình ảnh đã tạo.

- Browser Use nói nơi một script của trang bị lỗi. `evaluate` chỉ giữ dòng đầu của lỗi trình duyệt, nên một script nhiều dòng báo `TypeError: ...` mà không có gì để định vị. Lỗi giờ mang theo khung ngăn xếp trong cùng, và bộ kiểm thử tích hợp cố định vị trí mà một throw ở dòng sau báo cáo.

- Browser Use gọi tên một PDF thay vì báo một trang trống. Mở một liên kết tới PDF xác nhận địa chỉ, nhưng guest không có trình xem cho nó, nên snapshot hiển thị một trang không tiêu đề, không văn bản và nhiễu console về một stylesheet trình xem bị chặn — không có gì nói điều gì đã xảy ra. Báo cáo trang giờ nêu tài liệu là PDF mà trình duyệt này không thể hiển thị và tệp phải được đọc từ URL của nó, và các lỗi mà thành phần đi kèm của chính Chromium gây ra cho tài nguyên `chrome-extension://` của chúng không còn xuất hiện như lỗi console hay mạng của trang. Bộ kiểm thử tích hợp bao phủ điều hướng, báo cáo yên tĩnh, và một snapshot sau đó của trang.

- Browser Use ngừng đẩy `close_tab` ra khỏi tab đang hiển thị. `list_tabs` in trang đang hiển thị với một id trang thông thường, nên nhắm `close_tab` vào nó bị trả lời bằng `unknown background tab "p12"; call list_tabs` — chính danh sách đã đưa id ra. Lời từ chối giờ nói trang thuộc về bảng trình duyệt và chỉ tới việc điều hướng nó đi nơi khác hoặc `hide`, còn các tên không liên quan vẫn báo unknown background tab.

- Browser Use nói một xác nhận rời trang thực sự đã làm gì. Một trang bảo vệ công việc chưa lưu đã chặn một lần điều hướng bằng hộp thoại `beforeunload`, và phản hồi yêu cầu `handle_dialog` — nhưng Chromium tự trả lời xác nhận đó, nên lệnh gọi luôn trả về "no JavaScript dialog is currently open" trong khi lặp lại điều hướng lặp lại cùng chỉ dẫn. Phản hồi giờ nêu rằng điều hướng đã bị bỏ và trang vẫn ở lại, rằng không còn gì để trả lời, và công việc mà trang đang giữ phải được hoàn tất hoặc loại bỏ trước; bộ kiểm thử tích hợp giữ toàn bộ chuỗi, kể cả việc điều hướng đi qua một khi lớp bảo vệ không còn.

- Giả lập locale của Browser Use đến được máy chủ. `emulate locale` chỉ đặt `navigator.language`, nên trang vẫn yêu cầu ngôn ngữ cũ và các trang web thương lượng nội dung mâu thuẫn với giả lập; giờ nó mang locale cả trong `Accept-Language`, và xóa nó khôi phục thương lượng của chính trình duyệt.

## v0.9.171 - 2026-09-18

- Khôi phục bản phát hành: artifact relay production được chuẩn bị chỉ gắn với lần chạy (`production-relay-<run_id>`) và được tải lên với `overwrite: true`. Tên đó từng mang số lần chạy lại, nhưng một lần chạy lại một phần giữ nguyên job `stage-production-web-relay` đã thành công trong khi chạy lại `deploy-production-web-relay` như một job phụ thuộc vào job thất bại, nên artifact theo số lần chạy không bao giờ tồn tại và bản triển khai chết ở "Artifact not found" trước khi chạm tới production. Đó chính là cách v0.9.170 phát hành bản GitHub và gói npm mà không triển khai web relay. `overwrite: true` giữ cho một lần chạy lại toàn bộ, nơi job stage thực thi lại, không xung đột với artifact của lần chạy trước, và cổng phát hành kiểm tra cả tên lẫn overwrite.

## v0.9.170 - 2026-09-17

- Hợp nhất system prompt. Mỗi quy tắc giờ chỉ nằm ở một nơi duy nhất: lớp dùng chung (`rules/shared/*.md`) chỉ là chính sách công cụ và mở đầu bằng `# Tool Calls` (gộp lô trước; `05-parallel-calls.md`), vai trò Lead là một tệp (`rules/lead/LEAD.md`: giao tiếp với người dùng, giao việc cho agent và thông báo hoàn tất nằm sau `<!-- tools: agent -->`, giọng điệu), và hợp đồng agent chung là một tệp (`rules/agent/AGENT.md`: chuỗi chỉ huy, không tự xác minh, tiếng Anh, dạng bàn giao). `00-general.md`, `02-persona.md`, `lead-brief.md`, `00-core.md`, `00-common.md` và `75-goal.md` đã bị loại bỏ — những câu còn giá trị của chúng được chuyển sang tệp chứa chúng, và những câu mà mô tả công cụ đã nêu (`load_tool`, `Skill`, `goal`, phê duyệt `memory`, `task wait`, outline `code_graph`, dạng lệnh gọi read, định tuyến Git, định tuyến browser/computer) chỉ được nêu ở đó. Thứ tự ưu tiên theo từng vai trò: yêu cầu rõ ràng mới nhất của người dùng đối với Lead, bản giao việc mới nhất của Lead đối với các agent. Quy tắc lời dẫn của Lead giờ kèm lý do (người dùng chỉ thấy văn bản của bạn) và yêu cầu một dòng, không đếm từ; quy tắc giao việc nói rằng agent không bao giờ thấy cuộc hội thoại, rằng các phát hiện được tổng hợp thành đường dẫn, dòng và thay đổi chính xác (không bao giờ "dựa trên các phát hiện của bạn"), và rằng kết quả của agent không bao giờ được dự đoán. Các quy tắc hành động phá hủy từng rải trên bốn mục giờ nằm trong một mục `# Destructive Actions`. Các tệp vai trò (`agents/*/AGENT.md`) bỏ các câu về blocker/bàn giao mà hợp đồng đã sở hữu; `maintainer` có thêm frontmatter name và description. Kiểu đầu ra: tiêu đề `## Depth` thay cho `## Depth Variation`, và cách diễn đạt báo cáo tiến độ chỉ nằm trong quy tắc Lead. Quy trình Default không còn mang đoạn dự phòng người đánh giá; nó đi cùng khối chế độ điều phối mà các chế độ ủy quyền chèn vào. Mô tả công cụ: `edit` không còn chỉ tới `apply_patch` trên các bề mặt đã lọc nó đi, `shell` nói Git chỉ đi tới `git` khi công cụ đó có mặt, `read`/`grep` bỏ các giới hạn byte mà runtime vẫn báo, `code_graph` nêu rằng `symbols` là outline. Các nhà cung cấp tự gửi lời nhắc theo vòng (`anthropic-oauth` dưới dạng thông điệp hệ thống theo phạm vi lượt, `cursor` qua relay của nó) khai báo `deliversRoundReminder` để kênh runtime giữ im lặng — các phiên Cursor không còn nhận lời nhắc gộp lô hai lần mỗi vòng. Kiểm tra nguồn gốc của lời nhắc gộp lô chuẩn hóa dấu phân cách đường dẫn và chấp nhận một thư mục được hiển thị như tiền tố của đường dẫn sâu hơn trong kết quả trước, nên một lệnh gọi tiếp theo trên đường dẫn mà kết quả cuối đã tiết lộ không còn bị coi là một lệnh gọi đơn lẻ không liên quan (trước đây hai lần dương tính giả mỗi phiên). Schema route của `setup` nêu `contextPercent` là số nguyên có giới hạn (executor vẫn yêu cầu bội số của 10) để Gemini ngừng nhận một placeholder enum không biểu diễn được. Các kỳ vọng kiểm thử cũ còn sót lại từ commit gộp lô được cập nhật, và hai bài kiểm thử phụ thuộc thời gian/môi trường được làm cho xác định. Kỹ năng dự án `gamerscroll-article` được giới hạn trong dự án của nó.
- Các bản phát hành GitHub giờ mang mục CHANGELOG.md của phiên bản làm ghi chú, theo sau là liên kết so sánh; bản nháp trước đây dựa vào ghi chú do GitHub tạo, vốn chỉ liệt kê các PR đã gộp và để trang chỉ có một liên kết `Full Changelog` trần vì Deploy commit thẳng vào main.
- Gộp lô công cụ: sau ba vòng gọi đơn của cùng một công cụ liên tiếp mà các lệnh gọi không cần nhau (không có đối số lấy từ kết quả trước, không có bước nào xếp sau một thao tác thay đổi; một công cụ khác sẽ khởi động lại chuỗi, nên read → shell → apply_patch không bao giờ bị báo; các lần task wait, Computer Use, bước browser và tải schema/skill không bao giờ được tính), hoặc một vòng gọi cùng công cụ chỉ khác nhau ở một trường mảng, runtime thêm một `<system-reminder>` ngắn nêu các đối số mảng trên bề mặt công cụ của phiên; nó lặp lại mỗi khi mẫu tái diễn và chỉ một vòng đã gộp lô mới xóa nó (được theo dõi là `batching_nudge`). Một `read` một tệp ngay sau một vòng grep/code_graph/glob/find đã định vị nhiều tệp nhận lại tập đã định vị theo dạng mà một lệnh gọi `read` nhận (`[{file_path, offset, limit}, …]`; mỗi tệp một read trong cùng phản hồi trên các nhà cung cấp mà schema read chỉ nhận chuỗi đường dẫn), được theo dõi là `located_sites`: một phiên Gemini 3.8 Flash đã ghi lại định vị tệp bằng grep 13 lần mà vẫn đọc từng cửa sổ một (63 lần read, 20 trong 28 tệp được đọc hai lần trở lên). Mô tả `read` và `grep` giờ nói rõ lô là gì — mọi tệp và phạm vi bạn sẽ chạm tới, trước khi chỉnh sửa, trong một lệnh gọi — và chân trang của read theo cửa sổ yêu cầu một lần read rộng hơn thay vì cửa sổ tiếp theo. Các quy tắc chung giờ nêu thứ tự làm việc trên tệp một lần (`# Tool Calls`: chỉ liệt kê khi phạm vi chưa biết → định vị mọi vị trí → một giai đoạn read gồm các cửa sổ `{file_path, offset, limit}`, ≤10 mỗi lệnh gọi → mọi chỉnh sửa trong một phản hồi → một lần xác minh) và bỏ các câu từng nêu các phần của nó ở ba nơi; mô tả `read`, `grep`, `edit`, `apply_patch` và `code_graph` rút gọn theo hợp đồng đó (code_graph từ ~150 xuống ~90 từ), và dấu hiệu giới hạn thông minh của read theo cửa sổ nêu dạng cửa sổ đã định vị; một lượt nữa cắt bớt văn xuôi tham số lặp lại các quy tắc hoặc chi tiết nội bộ (`Skill`, `find`, `cwd`, `git`, `code_graph.mode`, `grep.path`/`text`, `include_noise`, mẹo PowerShell và `timeout_ms` của shell) — bề mặt công cụ của lead giảm từ 13.4 KB xuống 12.7 KB. Các lần chạy GPT-5.6 tám tác vụ trước và sau giữ ở mức 8/8 với cùng khoảng vòng, thời gian và chi phí; hồi quy duy nhất tìm thấy trên đường (một vòng sao lưu cho đầu vào chỉ đọc và các khảo sát `git log` sau khi hai mệnh đề bảo vệ bị cắt) đã được khôi phục. Quy tắc sao lưu giờ nói bản sao đi đâu — trong cùng phản hồi với lần kiểm tra đầu tiên, không bao giờ là một vòng riêng — vì "inside the first inspection call" khiến GPT-5.6 mở 2.8 vòng chỉ để sao lưu mỗi lần chạy tám tác vụ khi lần kiểm tra đầu là một lệnh gọi `read` hoặc `git`; với cách diễn đạt đã sửa, nó không mở vòng nào và gộp mọi bản sao lưu với lần kiểm tra đó. Lời nhắc nối tiếp không còn coi một mảng trong một lệnh gọi đơn là một lô: một lần rà soát Gemini 3.8 Flash đã ghi chạy mười lăm vòng một lệnh gọi, xen kẽ các lệnh gọi `git` một và hai lệnh, và không bao giờ đạt được vì mọi vòng mảng đều đặt lại chuỗi. Kiểm tra nguồn gốc cũng nhớ sáu vòng thay vì hai, nên một danh sách tệp từ `git diff --name-only` đi từng mục mỗi vòng không còn coi mỗi mục là thứ mà diff trước đã tiết lộ. Thêm hai lời nhắc runtime: `late_locating` (một lệnh tìm kiếm không phụ thuộc vào kết quả của lần read trước đó) và `located_sites` trao một cửa sổ cho mỗi vị trí đã định vị — gồm cả các hàng `(Lstart-end)` của code_graph — tách thành nhiều lệnh gọi read khi quá mười. Các tệp chính sách route (`rules/routes/*.md`) giờ cũng khai báo một dòng `turn-reminder:` (đọc một lần trong khối `<system-reminder>` ở cuối lượt người dùng, trước phản hồi đầu tiên của lượt) và một dòng `round-reminder:` bên cạnh các quy tắc tĩnh của chúng; vòng lặp agent phân giải cái sau theo nhà cung cấp/mô hình và nó đến mô hình sau mỗi vòng công cụ — dưới dạng thông điệp hệ thống theo phạm vi lượt của Anthropic (`clear_at: next_user_message`) trên `anthropic-oauth`, mẫu mà Anthropic ghi tài liệu cho Claude Fable 5.1, hoặc dưới dạng `<system-reminder>` runtime sau các vòng gọi đơn ở nơi khác (`per_round`). Lời nhắc Fable 5.1 chuyển từ hằng số nhà cung cấp viết cứng sang các tệp route; các lịch sử đã ghi dưới câu cũ phát lại nó từng byte. Một tệp, `routes/common.md`, mang các lời nhắc gộp lô cho mọi route (tệp không hạn chế là nền; tệp nêu `models:` hoặc `providers:` bổ sung vào dòng đó cho các route của nó thay vì thay thế) — Gemini đi một lệnh gọi mỗi vòng khi kết quả công cụ đến, Grok gộp các lệnh gọi nhưng không bao giờ dùng đối số mảng: các schema công cụ đã làm phẳng của nó chỉ giữ nhánh vô hướng của mọi trường một-hoặc-nhiều (`read.file_path`, `grep.pattern`, `git.command`, …). Việc làm phẳng cho Grok giờ giữ nhánh mảng của các trường đó (một giá trị đi dưới dạng mảng một phần tử) và nói vậy trong mô tả trường, nên hợp đồng gộp lô cũng đúng trên nhà cung cấp đó. Các quy tắc chung có thêm mục `# Parallel Tool Calls` nêu hợp đồng một cách rõ ràng (các phiên Gemini 3.8 Flash đã ghi phát một lệnh gọi mỗi vòng ở 105/105 vòng; với mục đó, một lần chạy headless đã gộp bốn tệp và git trong một phản hồi). Các quy tắc gắn với nhà cung cấp/mô hình được nạp từ `rules/routes/*.md` qua frontmatter `providers:` / `models:` và được kết xuất sau các quy tắc chung trong BP1. `MIXDOG_ANTIGRAVITY_DUMP_DIR=<dir>` ghi mọi nội dung yêu cầu Antigravity (contents, tools, config; không bao giờ header hay token) để kiểm tra trên đường truyền, bản đối ứng Gemini của `MIXDOG_OAI_WS_DUMP_DIR`; `mixdog exec` cũng chuyển tiếp `MIXDOG_XAI_CACHE_TRACE` và `MIXDOG_XAI_RESPONSES_CACHE_SCOPE` cho các lần thăm dò cache xAI.
- Các yêu cầu xAI Responses không còn gửi `prompt_cache_key` theo từng phiên theo mặc định (`MIXDOG_XAI_RESPONSES_CACHE_SCOPE` giờ mặc định là `none`, giống hệt Grok Build): khóa theo phiên chia cache dịch vụ thành các nhánh riêng và ghi nhận hai lượt khởi động nguội mỗi lần chạy thay vì một, đồng thời không tái sử dụng được tiền tố giữa các phiên. `session` và `prefix` vẫn chọn được. `MIXDOG_ANTIGRAVITY_FC_MODE=AUTO|ANY|VALIDATED` ghi đè chế độ gọi hàm của Antigravity cho các lần chạy A/B, và `benchmarks/terminal-bench-2.1/analysis/tool-batching-by-model.mjs` báo tỷ lệ đa lệnh gọi và đối số mảng theo từng mô hình từ `agent-trace.jsonl`.
- `mixdog exec` gắn tài khoản OAuth được chọn trong nhóm provider-accounts của host (thông tin xác thực mà đăng nhập ghi hiện nay), quay về tệp thông tin xác thực cũ duy nhất; trước đây chỉ chấp nhận tệp cũ hoặc một `*_CREDENTIALS_PATH` tường minh, nên các host chỉ có nhóm thất bại với "credentials are unavailable". `mixdog exec` cũng không còn nằm chờ 2–4 phút sau câu trả lời trước khi phát `result`: việc xóa thư mục gốc tạm được thử lại trên Windows trong toàn bộ ngân sách rmSync (50 lần thử tuyến tính ≈ 128s, hai lần khi đường postmaster chạy lại) trong khi handle SQLite của sổ cái mức dùng và `pg.log` của một daemon ghi nhớ đang dừng vẫn còn mở. Sổ cái được đóng trước khi xóa và exec truyền ngân sách 10 lần thử (≈5.5s) (`cleanup({ rootRemovalRetries })`); một gốc còn sót được để cho bộ quét mồ côi định kỳ thay vì người gọi.

## v0.9.169 - 2026-09-16

- Code Tidy: Install giờ tải xuống các engine cốt lõi (Biome, ruff, shfmt, shellcheck, PSScriptAnalyzer) kèm tiến trình, và thẻ tích hợp liệt kê mọi engine cùng phiên bản, ngôn ngữ, nguồn và kích thước; các engine mà dự án nhặt được sau đó xuất hiện trong cùng danh sách. Các engine còn thiếu khi tidy sẽ được tải tự động theo mặc định (`tidy.downloads` vẫn tôn trọng `ask` và `never`). PSScriptAnalyzer là bản tải xuống được quản lý, xác minh sha256 từ PowerShell Gallery thay vì một module chỉ có trên host, và C# có một trình chạy dotnet-format thực sự. Sửa lỗi: tiêu đề diff của rustfmt 1.9 và đường dẫn `\\?\` được phân tích, các báo cáo Biome lớn không còn co về không phát hiện nào khi đầu ra bị chia khúc, khả năng sửa được phân loại qua `biome explain`, và quy tắc history-comment chỉ xóa những chú thích hoàn toàn là lịch sử và không bao giờ kéo dài quá chú thích (nó từng có thể xóa câu lệnh kế tiếp).
- Các hàng thanh bên dùng chung một thẻ trạng thái cạnh tiêu đề cho các tính năng tích hợp, plugin, kỹ năng, máy chủ MCP, lịch, webhook và agent: không có gì khi đã bật, nếu không thì là `Not used`, `Not installed`, `Installing… N%`, `Failed` hoặc `Not connected`. Các agent bị tắt giữ dòng mô hình của chúng.
- FastDirect từ chối đóng gói lại hoặc cài một `app.asar` có tập phụ thuộc production chưa đầy đủ và quay về bản dựng đầy đủ, nên một trình cập nhật hỏng (`Cannot find module 'graceful-fs'`) không còn bị mọi bản cập nhật gia tăng thừa hưởng.
- Các worker agent đã bị thu hồi không còn bị quét phiên hoặc danh sách agent của desktop làm sống lại; các phiên đã hoàn tất được đăng ký lại giữ thời điểm kết thúc thực của chúng, nên các lease hết hạn thay vì khởi động lại mỗi giờ.
- Các chế độ điều phối `none`, `focused`, `balanced` và `swarm` thay thế quy trình Solo và được chọn theo từng phiên; các cài đặt đã được bản địa hóa.
- Desktop: các liên kết đường dẫn cục bộ trong markdown mở trong trình soạn thảo, và trình soạn thảo mở được các tệp ngoài dự án.
- Browser Use tuần tự hóa snapshot theo từng trang và củng cố các đường ổn định và chụp.
- Computer Use: một renderer lớp phủ bị đóng băng được cho nghỉ và thay thế, trạng thái khôi phục đầu vào sống sót qua việc chuyển, và các fixture lớp phủ không còn thoát sớm trên máy một màn hình.
- Shell: các host PowerShell không còn chặn cứng `grep`, `sed` và `awk` ở bước kiểm tra trước; mô tả công cụ định tuyến công việc sang công cụ chuyên dụng. Các quy tắc, kỹ năng, README và `docs/context-efficiency.md` mới được làm mới.
- Kho mã được định dạng bằng Biome 2.5.13 (`biome.json` cố định phong cách hiện có), rustfmt, dotnet-format và PSScriptAnalyzer; các import không dùng, helper chết và export chỉ dùng trong tệp đã bị loại bỏ.

## v0.9.168 - 2026-09-16

- Đóng một phiên Computer Use luôn gửi yêu cầu giải phóng của chính nó. Việc giải phóng suy đoán của bộ hẹn giờ nhàn rỗi từng bị thừa hưởng khi nó còn đang chạy, nên một lần giải phóng sớm bị từ chối có thể để worker và các quyền giữ cửa sổ của phiên đang đóng bị ghim cho đến khi khởi động lại ứng dụng.

- Lớp phủ Computer Use: hai điều khiển, Dừng và Tiếp tục. Nút tạm dừng đã bị bỏ (chạm vào desktop đã trao quyền điều khiển cho người dùng); viên thuốc giờ hiển thị vì sao một điều khiển không khả dụng hoặc vì sao một yêu cầu thất bại thay vì phản ứng im lặng. Dừng khôi phục một lỗi dọn dẹp bị chốt khi mọi worker đầu vào đã thoát, nên host không còn cần khởi động lại ứng dụng, và việc xác nhận worker thoát chờ tối đa 5 giây thay vì 1.
- Computer Use chụp một cửa sổ từ bề mặt đã kết xuất của chính nó thay vì sao chép desktop, với ngân sách chụp có giới hạn; một lần giải phóng tài nguyên chưa xác nhận sẽ cho worker đó nghỉ. Phím và gõ ở nền được kiểm tra trước khi gửi bất kỳ đầu vào nào, nên một lộ trình không được hỗ trợ không làm gì. Một lệnh mới chờ cho đến khi lần giải phóng phiên trước được xác nhận. Dừng cũng chờ việc hủy lượt agent, độc lập với việc dọn dẹp đầu vào gốc.
- Việc chờ của Browser Use tôn trọng hủy và từ chối trộn một URL với văn bản từ tài liệu sau; việc khôi phục ảnh chụp toàn trang thất bại là kết thúc. Bộ chọn CSS giữ khoảng trắng bên trong, từ chối tập khớp quá lớn, và định địa chỉ duy nhất cho từng kết quả khớp. Các lượt tải xuống đồng thời dùng chung một tổng byte của phiên; lời nhắc phê duyệt mô tả hành động và địa chỉ, không bao giờ nêu giá trị biểu mẫu.
- Code Tidy là một tính năng tích hợp có thể cài đặt, giống Office: Cài đặt → Tích hợp cài và bật tắt nó, và kỹ năng `code-tidy` điều khiển công cụ `tidy`. Quét phát hiện các ngôn ngữ của dự án và phân giải từng formatter hoặc linter từ cấu hình dự án, rồi các tệp nhị phân cục bộ của dự án, PATH, hoặc bản tải xuống được quản lý xác minh sha256 (ask, auto, hoặc never). Nó chạy Biome, ruff, clang-format, shfmt, shellcheck, StyLua, gofumpt, dprint, Air và Mago, cùng rustfmt, gofmt và PSScriptAnalyzer của toolchain, và áp dụng các gói cấu trúc (xóa history-comment, `debugger`, catch rỗng, dấu TODO) trên 31 ngôn ngữ. `fix` là chạy thử trừ khi đặt apply, và việc ghi đi qua cùng đường ống như các chỉnh sửa khác. Giấy phép của các engine đi kèm công cụ.
- Người gọi và người được gọi của `code_graph` đến từ các vị trí gọi đã phân tích, không phải tìm kiếm văn bản; các tham chiếu có dạng lệnh gọi cũng dùng các vị trí đó. Một tệp nhị phân graph cũ không thể phát chúng sẽ thất bại kèm cách khắc phục là dựng lại thay vì một câu trả lời trống. Các hàng outline dùng một từ vựng loại duy nhất, đánh dấu export, hiển thị chữ ký, và lồng các thành viên dưới cha của chúng. `find_symbol` ưu tiên tệp triển khai hơn `.d.ts` đi kèm và báo khi khai báo nằm ngoài các tệp được yêu cầu. Các token định danh đến từ cây phân tích, nên một tên chỉ xuất hiện trong chú thích không còn được tính là tham chiếu. Solidity, Haskell và HCL gia nhập tập trích xuất cùng các cạnh import (24 ngôn ngữ trích xuất, 31 được phân tích). Dữ liệu vị trí gọi nằm trong một cache phụ nên cache graph chính giữ nguyên kích thước.
- Tệp nhị phân graph gốc nhúng tree-sitter 0.27 và ast-grep 0.45.3, thêm các chế độ `--scan`, `--langs` và `--outline`, và trích xuất ký hiệu, import và token định danh từ các quy tắc YAML.
- Outline dự phòng graph của trình soạn thảo desktop phân tích các hàng ký hiệu mới thành một outline lồng nhau với biểu tượng loại.
- Các câu hỏi về cấu trúc (export, chữ ký, thành viên, người gọi, người import) đi tới `code_graph` trước `read` hoặc `grep`; cách diễn đạt về song song của quy trình công cụ là một quy tắc.
- Bảo trì ghi nhớ không còn đưa các bản tóm tắt hội thoại thành hướng dẫn thường trực: không có chu kỳ thứ ba. Chu kỳ 2 rà soát lịch sử tìm kiếm để tìm trùng lặp và dòng dõi mà không ghi lại các bản tóm tắt. Ghi nhớ thường trực vẫn do người dùng biên soạn qua `memory`; `recall` tìm trong toàn bộ lịch sử theo mặc định, kể cả các hàng đã lưu trữ trước đó.
- Mức dùng Antigravity Gemini hiển thị các cửa sổ 5 giờ và hàng tuần dùng chung từ bản tóm tắt hạn mức tài khoản, không phải bộ đếm danh mục theo từng mô hình, và các yêu cầu dùng kênh hàng ngày mà không có failover host tự động.
- Ngăn Agent chỉ mở rộng các hàng bạn mở, hiển thị số lượng hậu duệ trên lead, và nói "Waiting for agents" trong khi các hậu duệ vẫn đang làm việc thay vì coi cha là rảnh hoặc đã xong.
- Ô soạn thảo cung cấp một bảng lệnh gạch chéo nhỏ cho các lệnh thường dùng (`/new`, `/model`, `/compact`, `/context`, `/goal`, `/inherit`, `/fast`); toàn bộ sổ đăng ký vẫn chạy khi gõ trực tiếp.
- Các đề cập tệp trong hội thoại vẫn là văn bản thuần cho đến khi đường dẫn được xác nhận trong Dự án sở hữu; thư mục và tài liệu vẫn mở trong hệ điều hành, và các lần mở trình soạn thảo truyền một access token.
- Danh sách mức dùng ở thanh bên căn nhãn nhà cung cấp, đồng hồ, phần trăm và thời điểm đặt lại trên một lưới; danh mục mô hình giữ bảy mục gần đây.
- Một phiên mới chờ cho đến khi các lần lưu cài đặt đang chờ hoàn tất, và các công cụ MCP đã rời khỏi danh mục hiện tại không bị gọi giữa lượt.

## v0.9.167 - 2026-09-15

- Khởi đầu phiên báo các công cụ shell phổ biến nào có mặt ("Shell tools at startup"), đo trong login shell trên POSIX và trong PATH của tiến trình trên Windows, nên mô hình không còn đoán `python` hay `python3` hoặc gọi `file` ở nơi nó không có; câu trả lời không xác định thì không hiển thị gì.
- `read` kết xuất các cửa sổ chồng lấn của một tệp một lần, không còn báo các phạm vi chỉnh sửa chưa đọc là đã giao, và không bao giờ thừa hưởng dấu "đã giao toàn bộ nội dung" cũ sau khi tệp thay đổi; các lần read mảng tôn trọng tùy chọn no-stub của chúng và mô tả nêu các giới hạn đầu ra thực.
- `git` chạy các lệnh nối bằng `&&` như một mảng có thứ tự (tới 10) thay vì từ chối chúng, và nhận ra các kho bare.
- Cache read của phiên tôn trọng danh sách cho phép công cụ, phát hiện các thay đổi chỉ ở `ctime`, không bao giờ lưu nội dung chụp trước một thay đổi giữa lúc đọc, tách riêng gợi ý offset công khai và cũ, và bao phủ các lần read mảng công khai.
- Các mảng `web_search` giữ cờ lỗi cho các thất bại một phần và toàn phần.
- Các quy tắc và mô tả công cụ tích hợp ngắn hơn với cùng hành vi: mô tả `shell` mang bản đồ lệnh→công cụ và cấm dùng tên công cụ làm lệnh shell; hướng dẫn `timeout_ms` bao gồm các kiểm tra dùng một lần; hướng dẫn Lead chỉ áp dụng với công cụ `agent` bị bỏ khỏi các quy trình không ủy quyền; các quy tắc yêu cầu mọi hành động độc lập mà bằng chứng hiện tại đòi hỏi trong một phản hồi, vá trực tiếp từ bằng chứng quyết định, một mẫu trước khi viết logic phân tích, và các lát có giới hạn cho dữ liệu lớn hoặc nhị phân.
- Runtime desktop được đồng bộ với công việc harness browser và computer hiện tại, và các bài kiểm thử hợp đồng công cụ được củng cố tương ứng.

## v0.9.166 - 2026-09-14

- Studio nhận ra tài khoản ChatGPT đã chọn sau khi đăng nhập nhà cung cấp và chuyển tài khoản, dùng cùng đường thông tin xác thực như chat mà không quay về thông tin xác thực của tài khoản khác.

## v0.9.165 - 2026-09-14

- Dock Quản lý mã nguồn giữ cửa sổ hàng của nó gắn với danh sách trực tiếp: một dock được dựng lại (đổi tab, từ bề mặt chạy lần đầu sang danh sách) không còn cuộn vào các hàng trống.
- Các asset phát hành macOS được tải lên qua script xóa-rồi-thử-lại trên cả hai kiến trúc, nên một lần chạy khôi phục không còn thất bại ở asset đã tồn tại trên bản nháp ẩn.
- Cổng phát hành: mọi làn chạy xanh trên các runner được lưu trữ. Linux cài NanumGothic cho PDF tiếng Hàn và LibreOffice hiện tại cho các bản rà soát đã kết xuất; kiểm tra con trỏ Windows cố định tùy chọn chuyển động của nó; các kỳ vọng kiểm thử theo sát các hợp đồng đã phát hành.

## v0.9.164 - 2026-09-14

- Nén các quy tắc chung và Lead cùng các mô tả công cụ tích hợp về cùng hành vi với ít token hơn; mô tả `shell` chỉ giữ vai trò của nó, ranh giới với các công cụ tệp/tìm kiếm/Git chuyên dụng, và hợp đồng tác vụ nền.
- Các lần chạy headless (`mixdog exec`) nêu rằng không có người dùng can thiệp giữa chừng: yêu cầu được coi là đã phê duyệt và thực hiện đến cùng trước khi báo cáo, thay vì dừng lại hỏi một câu mà không ai trả lời được.
- `apply_patch` gõ vào shell không còn bị định tuyến lại sang engine vá; mô hình gọi `apply_patch`/`edit` trực tiếp.
- Một Goal đã dừng được cho nghỉ như một Goal đã hoàn thành: lời nhắc kế tiếp của người dùng lưu trữ nó, và xác nhận dừng lưu trữ nó ngay lập tức.
- Thống kê mức dùng gán token và chi phí đo được cho từng yêu cầu trong sổ cái, và trình khám phá mức dùng trên desktop hiển thị bảng phân tích kết quả.
- Sửa lỗi giao thức của nhà cung cấp Cursor.

## v0.9.163 - 2026-09-10

- Tinh chỉnh bản địa hóa giao diện, chọn ngôn ngữ khi khởi động, menu gốc và định dạng đã dịch; giữ bootstrap ngôn ngữ web luôn mới qua các bản cập nhật.
- Củng cố quyền sở hữu đầu vào của Computer Use và các kiểm tra chỉ quan sát, xác nhận các mục tiêu văn bản Electron trước khi gõ, và cải thiện xử lý con trỏ và phiên.
- Cải thiện tìm kiếm tệp gốc và các lần read theo phạm vi, và ngăn các phép tính đang chạy đã bị vô hiệu hoặc hủy nạp lại cache kết quả.
- Bao gồm các benchmark tìm kiếm, phạm vi kiểm thử hồi quy, các cuộc kiểm toán bản địa hóa, và các sản phẩm bàn giao dự án và tài liệu được tạo ra.

## v0.9.162 - 2026-09-09

- Hộp thoại Đặt mục tiêu mở ở giữa ngăn có ô soạn thảo đã gọi nó, chỉ làm mờ ngăn đó; các ngăn anh em vẫn hiển thị và dùng được và thanh tiêu đề không còn bị làm mờ. Ngoài một ngăn, nó quay về lớp cửa sổ.
- Một ngăn đang focus không còn che tay cầm chia ở cạnh của chính nó: ngăn trình duyệt (hoặc bất kỳ ngăn focus nào) lại có thể đổi kích thước từ ranh giới trái/trên.
- Web fetch báo một giai đoạn hết thời gian ở hạn chót tổng là `FETCH_TIMEOUT` thay vì `STAGE_TIMEOUT`.
- Computer Use mặc định chuyển đầu vào ở nền cho đầu vào ngữ nghĩa được hỗ trợ; `foreground_unavailable` giờ yêu cầu người dùng kích hoạt cửa sổ đích thay vì mô tả lỗi khóa nền trước.
- Lần chạy phát hành v0.9.162 dừng ở cổng kiểm thử và không phát hành gì; các ghi chú của nó bên dưới được giao trong bản phát hành này.

- Mixdog giờ được cấp phép theo Apache-2.0 thay vì MIT. Các thành phần bên thứ ba giữ giấy phép và thông báo ghi công hiện có của chúng.

- Browser Use và Computer Use hỏi một lần cho mỗi phiên trước lệnh gọi trực tiếp đầu tiên. Lệnh gọi `browser`/`browser_devtools` hoặc `computer` đầu tiên mà mô hình thực hiện trong một phiên đi qua lời nhắc phê duyệt công cụ cùng hành động nó muốn thực hiện; cho phép nó bao phủ phần còn lại của phiên, từ chối trả lý do cho mô hình kèm chỉ dẫn không thử lại, và khởi động lại sẽ hỏi lại. Các phiên không có giao diện phê duyệt (headless, do agent sở hữu) không bị chặn. `setup set_first_use_approval name:browser|computer enabled:false` tắt nó theo từng khả năng, và `MIXDOG_BRIDGE_FIRST_USE_APPROVAL` ghi đè theo từng tiến trình.

- Browser Use gộp hai cử chỉ vào những cử chỉ bên cạnh chúng. Một checkbox hoặc radio được đặt bằng `fill` với `checked` thay vì `text` — cho một điều khiển, một mục `fields`, hoặc một bước `sequence` — nên hành động `check` riêng đã bị bỏ; và `forward` bị bỏ, vì snapshot trước đã cho thấy URL để `navigate` tới trong khi `back` vẫn là một cử chỉ. `locate` và `extract` được giữ: cái đầu là tìm kiếm trực quan (pixel) không có tương đương ngữ nghĩa, cái sau đọc các hàng qua các khung và shadow root mở mà `evaluate` không với tới.

- `capture` của Computer Use bỏ các núm `quality`, `maxWidth` và `max_ocr_words`: các mặc định đã tinh chỉnh của host được áp dụng (chất lượng JPEG, chiều rộng thu nhỏ, và giới hạn từ OCR mà ngân sách phần tử đã giới hạn sẵn), và chi tiết không đọc được là việc của `zoom` thay vì mã hóa lại. Các bộ lọc phần tử (`query`, `role`, `visible_only`, `include_noninteractive`, `continuation`) và hình học di chuyển `window` giờ nói chúng làm gì thay vì đi kèm schema mà không giải thích.

- Browser Use và Computer Use nêu nấc của chúng trên thang công cụ ở nơi mô hình quyết định. Mô tả `browser` mở đầu bằng "last resort: prefer web_fetch, an MCP tool, or a CLI in shell", `computer` bằng "last resort after an MCP tool, shell/CLI, and Browser Use; never a stand-in for a page action browser refused", và các quy tắc chung cùng hai kỹ năng mang cùng thang đó, nên một dịch vụ có API hoặc CLI được tiếp cận qua đó thay vì qua màn hình. Không mô tả nào dài thêm: thang thay thế cách diễn đạt mà các kỹ năng vốn đã sở hữu.

- Browser Use là hai công cụ. `browser` giữ công việc trang hàng ngày — navigate, snapshot, read, click, fill, biểu mẫu, hộp thoại, tab, tải xuống, đọc console và network — trong khi các điều khiển nhà phát triển `emulate`, `cookies`, `storage`, `intercept`, `init_script` và `performance` chuyển sang công cụ trì hoãn `browser_devtools`, vốn điều khiển cùng các trang và đăng nhập và nạp schema ở lần gọi đầu. Schema hàng ngày bỏ 33 trường chỉ các hành động đó dùng (thuộc tính cookie, định vị địa lý, giới hạn CPU, nội dung intercept, tùy chọn trace), ghi chú trường của mỗi công cụ chỉ nêu các hành động của riêng nó, và một lệnh gọi tới sai công cụ bị từ chối kèm công cụ cần gọi. Host, sổ đăng ký hành động, chính sách phê duyệt và bộ kiểm thử tích hợp giữ một hợp đồng hành động dùng chung duy nhất.

- Các schema công cụ tích hợp chỉ nêu hợp đồng. Mô tả và ghi chú trường của các công cụ `office`, `computer`, `media` và `setup` bỏ các câu về phương pháp và chính sách mà kỹ năng của chúng vốn đã sở hữu — gộp lô, khi nào snapshot hoặc `describe`, sửa một kết quả kiểm toán trong cùng lượt, tái sử dụng `design.content`, xử lý macro, không sắp xếp lại, nội dung màn hình không bao giờ cho phép một hành động, thăm dò video, quy trình phê duyệt xóa — giúp loại khoảng 2.2 KB (office −878 B, computer −492 B, media −432 B, setup −424 B) khỏi bề mặt công cụ gửi mỗi lượt. Các kỹ năng pptx, xlsx và pdf giờ mang các quy tắc từng chỉ nằm trong schema (một lô các thao tác đã biết, `describe` chỉ cho trường chưa biết, nội dung tài liệu không đáng tin), và kỹ năng computer-use nêu hợp đồng gọi một lần thay vì lặp lại từng câu schema.

- Browser Use cần ít lệnh gọi hơn cho mỗi tác vụ. `click`, `fill`, `type`, `select`, `hover`, `upload` và `scroll` — cùng mọi mục `fill.fields` và bước `sequence` — chấp nhận `target` không cần snapshot (`{role, name}`, `{name}` hoặc `{selector}`) thay cho `ref`: host tự quan sát trang, chỉ tác động khi có đúng một kết quả khớp (nhiều kết quả khớp chuỗi con được phân giải về kết quả khớp nguyên văn duy nhất), và một target mơ hồ thất bại kèm các ứng viên và ref mới của chúng. `query` trên `snapshot`, `read` và `wait` khớp các từ khóa cách nhau bằng khoảng trắng với OR (kết quả khớp mọi từ khóa xếp trước) và nhận biểu thức chính quy `/pattern/i`, và một bộ lọc không khớp gì nói nó đang lọc bao nhiêu phần tử hoặc ký tự. Các điều khiển trong suốt hoặc pointer-events:none không còn bị từ chối hoàn toàn: một checkbox ẩn được nhấp qua label của nó, và bảo vệ đích đầu vào chấp nhận kích hoạt của label. `fill` trên trình soạn thảo `contenteditable` thay thế nội dung như đầu vào đã gõ trên một thao tác chọn tất cả thay vì ghi đè DOM của nó. Các phản hồi ghi chú "No observable change" khi một cử chỉ để nguyên tài liệu, URL và giá trị điều khiển, `brief:true` chỉ liệt kê các phần tử mới hoặc đã thay đổi kể từ lần quan sát trước, lỗi console được báo một lần khi mới, và một hậu điều kiện vốn đã đúng là cảnh báo thay vì lỗi. Snapshot đánh dấu các input tệp bằng `file-input`, `accept=…` và `multiple`; ảnh chụp toàn trang neo các phần tử fixed và sticky trong luồng cho lần chụp; và cookie phiên được lưu mã hóa bằng keychain của hệ điều hành và khôi phục khi khởi chạy để các đăng nhập sống sót qua khởi động lại ứng dụng.

- Phần chrome phía trên ô nhập prompt — viên Mục tiêu, tiến trình runtime, phê duyệt công cụ, thanh ngữ cảnh bản nháp và khe xem lại lượt — giờ nằm trong một `ComposerDock`, và bản ghi hội thoại không còn nhấp nhô khi phần chrome đó được giải quyết: khe xem lại vẫn được giữ chỗ trong khi lần đọc worker có thẩm quyền đầu tiên của một phạm vi đang diễn ra, nên một diff đến sau khi bản ghi đã hiển thị lấp đầy hình học hiện có thay vì đổi kích thước viewport lần nữa. Không gian được giải phóng không bao giờ bị giữ bằng bộ hẹn giờ. Host desktop cũng ngừng đọc lại cả phiên sau mỗi prompt được chấp nhận (khôi phục "missing baseline" trong nhật ký daemon): một khung phản hồi hoặc làn lặp lại phiên bản mà phép chiếu đã giữ là trạng thái đã áp dụng, không phải đường cơ sở bị chéo. Các lần bật/tắt gắn/gỡ viên Mục tiêu có thể truy vết dưới `MIXDOG_DESKTOP_PERF=1`.

- Viên Goal không còn tự bật ra rồi biến mất. Hai đường công bố gây ra nhấp nháy: nhịp route 2s đọc bản ghi Goal thô trong khi kho lưu trữ đầu vào người dùng của một Goal đã hoàn thành vẫn đang được ghi, nên viên đã cho nghỉ quay lại trong một khung hình; và trên Windows một lần đọc Goal rơi vào giữa lúc thay thế tệp nguyên tử (`EPERM`/`EACCES`/`EBUSY`, hoặc lần ghi đang chạy của chính runtime) hiện ra là "no Goal" cho khung hình đó. Các lần công bố route giờ đọc Goal qua mặt nạ lưu trữ goal-continuation, và kho Goal trả lời các lần đọc như vậy từ bản ghi đã commit gần nhất.

- Browser Use không còn dừng để chờ phê duyệt: hộp thoại "Cho phép một lần" trên desktop từng bảo vệ `upload` và `clear` cookie/localStorage dùng chung đã bị bỏ, trường `confirm` rời khỏi hợp đồng công cụ browser, và kỹ năng browser-use bỏ các quy tắc đồng ý trong hội thoại của nó. `MIXDOG_BROWSER_CONFIRM_ACTIONS` và `MIXDOG_BROWSER_DENY_ACTIONS` vẫn là cách duy nhất để xác nhận hoặc từ chối các hành động được nêu tên.

- Cột đọc của ngăn — ô soạn thảo, bản ghi hội thoại và dock Studio — không còn chờ một ngăn 1536px giãn ra: từ 768px nó giữ 800px cho đến khi ngăn vượt 1000px, rồi theo 80% của ngăn tới trần 1000px ở 1250px, nên các cửa sổ 1536/1680 và 1920 khi mở bảng bên thôi đỗ lại ở 800px, và một thanh chia vượt qua bước không còn làm cột nhảy 200px.

- Bảng Phiên mở đầu bằng hai hàng khởi chạy cố định, `New task` (Tác vụ mới) và `New Studio` (Studio mới), ghim phía trên danh sách phiên. Do đó Studio rời thanh hoạt động: mục thanh chỉ để khởi chạy của nó và các ngoại lệ khởi chạy trong bố cục chế độ xem bên, dock ngăn và các nút bật tắt dock bị loại bỏ, và bố cục thanh đã lưu bỏ id `studio` khi nạp.

- Đích Quy trình của thanh hoạt động gộp vào bảng Dự án: thanh công cụ `Project | Workflow` (Dự án | Quy trình) — công tắc phần của bảng Tiện ích mở rộng, nay dùng chung như một thành phần `SidebarSectionToolbar` — chuyển giữa danh sách dự án và các gói quy trình, agent mặc định và định nghĩa agent; nút `+` ở tiêu đề theo tab Dự án; `/workflow` và `/websearch` mở tab Quy trình; và bố cục thanh đã lưu bỏ chế độ xem `workflows` đã loại bỏ khi nạp.

- Bộ công cụ của kỹ năng pptx có thêm một từ vựng thiết kế theo kiểu các hệ thống thiết kế dựa trên token: `palette()` suy ra ba độ đậm đường kẻ (`lineSubtle`, `line`, `lineStrong`) và bốn màu trạng thái (`T.state.positive | warning | critical | informative`, mỗi màu dưới dạng `solid` / `weak` / `text`, đảm bảo tương phản và giữ dưới dải bão hòa của bộ rà soát để một cột kết luận không bao giờ kích hoạt `accent_hue_overuse`); mọi khoảng cách nằm trên một thang khoảng cách (`SPACE`) được đặt tên theo quan hệ (`GAP.bind` / `within` / `between`, `GUTTER`, `PAD`, `M`); mỗi vai trò văn bản mang một leading cố định; các hạt lặp lại (huy hiệu, callout, dải chevron, stat, bảng) đọc cấu trúc của chúng từ `SPEC` với các biến thể `tone`, một bước thang `stat` và một helper `statBand()`; biểu tượng ánh xạ tới bốn dải kích thước; và một `references/writing.md` mới cố định các quy tắc về câu, văn phong, số, ngày, tiền, đơn vị và chỗ trống cho bản dịch, được liên kết từ các kỹ năng docx và xlsx. Mỗi hạt spec ký hình dạng của nó, và biên nhận bố cục đọc lại các chữ ký (`slides[].specs`, `deck.specs`: số lượng, slide, biến thể, cấu trúc) nên một hạt có cỡ chữ hoặc kiểu chữ lệch giữa các slide hiện ra như một cấu trúc thứ hai.

- Các token thiết kế Office suy ra cùng bốn màu trạng thái (`positive`, `warning`, `critical`, `informative`, mỗi màu có một trường `Weak` và một bước `Text`, kiểm tra tương phản với canvas, bảng sáng và trường); các cổng quyết định docx và xlsx vẽ Release và Stop trên các trạng thái positive và critical thay vì một màu sắc nguyên văn và điểm nhấn thứ hai, và `calloutTone` của một mục `compose_document` đặt callout của nó lên một trạng thái. Vùng in của một dashboard `compose_sheet` giờ theo bảng quyết định, nên một cổng Stop ở cột ngoài canvas không còn bị cắt khỏi trang đã kết xuất và xuất ra.

## v0.9.161 - 2026-09-06

- Các cuộc kiểm toán Office đo Arial, Helvetica, Times New Roman, Courier New, Calibri, Cambria và Georgia bằng các phông mở tương thích số đo (Liberation, Arimo/Tinos/Cousine, Carlito, Caladea, Gelasio) ở nơi bản gốc chưa được cài, thay vì báo phông không khả dụng và ước lượng độ vừa khít — một máy Linux có các phông Liberation giờ kiểm toán một bản trình bày như Windows. Gói gốc có thêm các làn `test:slow` và `test:live`, và các làn runtime của CI cài các phông Liberation.

- Các commit Quản lý mã nguồn nhận phần tóm tắt gõ tay cộng với phần mô tả tùy chọn: các preset thông điệp commit, kiểm tra định dạng, tự động hoàn thành và tạo bằng AI rời khỏi thẻ Git & GitHub và biểu mẫu commit, và các tùy chọn `desktop.git` cũ không còn được đọc hay ghi.

- Computer Use bỏ trình soạn thảo ủy quyền ở phía cài đặt (khóa cửa sổ và hành động, hết hạn): nó vẫn không hạn chế theo mặc định với các bảo vệ thường trực — bảo vệ đầu vào, xử lý nâng quyền, người dùng giành quyền, bảo vệ môi trường — và một tệp ủy quyền đã lưu không còn có thể hết hạn thành bị khóa ngoài. Việc thu hẹp trong tiến trình vẫn còn cho host nhúng qua `MIXDOG_COMPUTER_POLICY_FILE` và `host.updateAuthorization`, không có gì được lưu, và việc xuất chẩn đoán lỗi vẫn giữ. Công cụ có thêm `wait_for_user`: khi người dùng giành quyền điều khiển, mô hình chờ một khoảng có giới hạn rồi chụp trạng thái mới thay vì đoán về quyền.

- Mọi thẻ Tiện ích mở rộng và Tích hợp mở cùng một hộp thoại chi tiết — tấm nhận diện và tiêu đề, các mục theo cùng một nhịp, một chân trang có hành động phá hủy đặt bên trái, một kiểu nút hành động — và các hộp thoại thêm/sửa Dự án cũng gia nhập. Thẻ Git & GitHub mang tài khoản GitHub (đăng nhập gh bằng mã thiết bị); thẻ Local Provider liệt kê các mô hình đã cài với kích thước, ngữ cảnh và trạng thái chạy, một mục Tải mô hình cho việc giải phóng khi nhàn rỗi, và các thông tin trực tiếp (bản dựng runtime, GPU, bộ nhớ trống, máy chủ), trong khi việc sửa chữa và xác minh vẫn do chat điều khiển qua kỹ năng local-provider. Thông tin trạng thái/nền tảng rời khỏi các hộp thoại vì nút điều khiển ở tiêu đề và huy hiệu danh sách đã nói rồi. Các stylesheet tiện ích mở rộng được tách thành `extension-list.css`, `extension-dialog.css`, `extension-editors.css` và `rail-controls.css`.

- Goal: tiếp tục một Goal đã tạm dừng và bắt đầu tác vụ đã được phê duyệt của nó là một lần ghi bền vững — `resume` chấp nhận cập nhật và bổ sung tác vụ, đánh dấu một tác vụ `in_progress` sẽ tiếp tục Goal, và việc ghi sổ đơn thuần không bao giờ cấp phê duyệt. Trạng thái của một Goal đã tạm dừng đến được mô hình khi yêu cầu được chuẩn bị, sau khi nạp, thay vì một lời nhắc dùng một lần trên câu trả lời của người dùng, nên không lượt nào có thể mất thông tin rằng một Goal đang chờ.

- Điện thoại đồng bộ các khung nhìn khi kết nối lại: sau bắt tay bảo mật, trình duyệt hỏi desktop một đường cơ sở nhất quán cho các phiên đang mở (snapshot, danh sách phiên, nhóm agent, trạng thái phiên) và các công bố trực tiếp được giữ lại cho đến khi nó đến, nên một điện thoại kết nối lại không còn vẽ bản ghi hội thoại cũ hay bỏ lỡ phần cuối của một lượt. Bản ghi hội thoại giao cho điện thoại bỏ tài liệu phát lại của nhà cung cấp ở cả delta lẫn đường cơ sở.

- Việc tạo tác vụ mới vẫn an toàn khi kết nối từ xa bị ngắt: mỗi yêu cầu mang một biên nhận bền vững, nên một lần thử lại sau khi hết thời gian hoặc kết nối lại rơi vào cùng phiên đã giữ chỗ thay vì tạo bản sao, và bộ theo dõi kho dự án tự khôi phục và đối chiếu danh mục trong lúc nó ngừng.

- Các cuộc hội thoại và thanh tab hiện ra mà không giật: một bản ghi hội thoại đã ghé thăm hiển thị khi các hàng nhìn thấy và offset cuối khớp nhau qua các khung hình (giới hạn trong một giây, nên phát trực tiếp hay phông chậm không bao giờ che nó), và một thanh tab quyết định tràn dựa trên bố cục đích thay vì một tab đang giãn nửa chừng.

- Các hành động danh mục Local Provider (`searchLocalProviderModels`, `inspectHuggingFaceModel`, `registerHuggingFaceModel`) tồn tại trên bề mặt phiên mà daemon phân giải chúng, nên một lệnh gọi setup định tuyến qua desktop không còn thất bại như một hành động phiên không khả dụng.

- Các danh mục ngôn ngữ giao diện desktop đồng bộ trở lại với renderer: các chuỗi mà các khung nhìn quản lý mã nguồn và lệnh gạch chéo đọc qua `t()` bị thiếu ở mọi danh mục (tab hiện "History" bằng tiếng Hàn), các cụm tiếng Hàn của gói dịch cũ đã loại bỏ được chuyển vào `ko.json` để các nhãn động ("Ln 42", "Callers of …") lại được dịch, và các chuỗi menu và hộp thoại gốc được tạo từ cùng các danh mục. Tiếng Hàn đầy đủ; mười ngôn ngữ còn lại quay về tiếng Anh cho các cụm mới hơn cho đến khi được dịch.

- Bản dựng trình nhập trình duyệt thay thế một bản checkout upstream viết dở trong TEMP thay vì thất bại vì nó. Bộ kiểm thử: các suite renderer có thể import các module kéo theo stylesheet tính năng (một import `.css` phân giải thành module rỗng dưới Node), kiểm tra import daemon từ artifact đã dựng chạy ở làn live sau khi dựng, và các fixture đường dẫn kho cài đặt phân giải theo ngữ pháp đường dẫn của chính host.

- Kỹ năng và runtime pdf áp dụng quy trình kiểm tra trước của các kỹ năng PDF tham chiếu. Đọc: một snapshot báo `encrypted` và `passwordRequired` thay vì lỗi riêng của pdf-lib, `open`/`snapshot` với `password` đọc văn bản của tệp bị khóa trong lệnh gọi đó mà không giữ mật khẩu, mọi chỉnh sửa trên tệp mã hóa chỉ tới `secure` → decrypt, các trang mang kích thước và độ xoay của chúng, dấu trang trả về dưới `outline` cùng trang mà mỗi dấu mở ra, và việc trích xuất văn bản (snapshot office, tệp đính kèm chat, công cụ read) giữ cuối dòng là ký tự xuống dòng nên đoạn văn và hàng bảng còn nguyên. Biểu mẫu: các trường hiển thị loại `text|checkbox|radio|dropdown|optionlist`, `options`, `readOnly` và `multiline` mà việc điền cần; `fill_form` nêu tên một trường hoặc tùy chọn không xác định cùng những gì tồn tại và báo `filled`; `add_form_field` và `create` chấp nhận `optionlist`, `required`, `readOnly`, `maxLength` và `fontSize`; lint đánh dấu một ô quá nhỏ để dùng (`formIssues` khi create, `field_too_small` trong `issues`); `preview_fields` ghi một bản sao với mọi trường và mọi ô đề xuất được viền và đặt tên để một bản kết xuất cho thấy vị trí trước khi điền; một dropdown hoặc danh sách có tùy chọn tiếng Hàn không còn thất bại khi tạo vì widget được vẽ bằng phông nhúng ngay từ đầu; và một trường nhiều dòng mặc định 11 pt thay vì kích thước tự động của pdf-lib, vốn vẽ dòng đầu rất lớn và bỏ phần còn lại. Phông: `create`, `add_text`, `watermark`, `fill_form` và OCR tự nhúng một phông Unicode đã cài khi văn bản là tiếng Hàn, CJK, Cyrillic hoặc Hy Lạp (`pdf-fonts.mjs`; `fontPath` vẫn quyết định; `detect` nêu tên phông là `portable.pdfUnicodeFont`). Ghi: `create` ngắt văn xuôi không có khoảng trắng theo ký tự, tôn trọng `\n`, ngắt dòng ô bảng và tăng hàng, lặp lại tiêu đề sau ngắt trang, đánh số đầu ra nhiều trang, và chấp nhận `columnWidths`, `level` của tiêu đề, `align` của ảnh, `orientation`, `footer` và nhiều khổ trang hơn. Chỉnh sửa: `merge_pdf` nhận `sources:[path | { path, pages, title }]`, `index` và `bookmarks:true`; `add_bookmark` ghi một mục outline; `extract_pages` ghi ra `output` và `split_pages` ghi một tệp đánh số cho mỗi trang hoặc mỗi `every` trang mà không chạm tài liệu của phiên; `extract_attachment` trích xuất các tệp nhúng mà vẫn giữ nguyên nội dung; `rotate_pages` cộng vào độ xoay hiện tại; `delete_pages` giữ lại một trang; `compress` báo `bytesBefore`/`bytesAfter`; `add_text` nhận `align:'center'|'right'` và đánh số một tệp có sẵn qua `{page}`/`{pages}`; `highlight` đánh dấu mọi kết quả khớp của `find` (hoặc một ô; `wholeWord`, `regex` và `first` thu hẹp) bằng một dấu trộn nhân giữ cho văn bản đọc được; `add_link` đặt một liên kết vô hình lên một kết quả khớp mở một URL hoặc trang khác, hoặc với `urls:true` làm mọi địa chỉ http(s) trong văn bản tự mở; `stamp_image` vừa trong lề trừ khi được đặt kích thước; `issues` không còn báo một trang quét hai lần và nêu tên nội dung chủ động (`active_content`: JavaScript, Launch, hành động khi mở, liên kết tới tệp hoặc các lược đồ không phải web) mà không đi theo nó. Phân tích: `pdf-layout` với `query` chỉ trả về các kết quả khớp cùng ô của chúng; các ô văn bản của nó theo dòng chữ trên các trang xoay và với văn bản chéo, nó và snapshot báo `origin` khi hộp trang không bắt đầu ở 0,0. Các dấu theo `find` đảo ngược phép biến đổi hiển thị để xử lý cả độ lệch gốc và độ xoay trang 90/180/270 độ mà không định hướng lại tài liệu; `first:true` giữ thứ tự hàng của tài liệu ở mọi độ xoay. Layout liệt kê liên kết của mỗi trang (`url` hoặc `page` đích) và thêm các đường kẻ (`lines`) và `boxes` của mỗi trang (các ô vuông nhỏ được đánh dấu `checkbox`), thứ mà việc điền một biểu mẫu không có trường cần; `pdf-tables` đọc một bảng có viền từ các hình chữ nhật ô của nó (`source:'ruled'`, ô được ngắt dòng còn nguyên) trước khi đoán theo căn chỉnh văn bản (`source:'alignment'`) và ghi một CSV cho mỗi bảng khi có `output:<dir>`, như `pdf-images` ghi các tệp PNG và báo mỗi bức ảnh nằm ở đâu trên trang; OCR làm mỗi từ vô hình vừa với ô của nó để lớp văn bản giữ khoảng trắng đơn. Xem trước trang (`render`, `qa`, `finalize`) trao cho pdf.js các phông chuẩn đi kèm, nên một trang đặt bằng Helvetica hay Times không còn bị kết xuất giãn chữ. Bộ điều hợp được tách thành `pdf-writer`, `pdf-forms`, `pdf-draw` và `pdf-fonts`, và kỹ năng được viết lại thành kiểm tra → tạo → chỉnh sửa → bảo mật → xác minh với yêu cầu qpdf (PATH hoặc `MIXDOG_QPDF_PATH`), lưu ý về bit quyền, và giới hạn văn bản tại chỗ được nêu rõ.

- Kỹ năng và runtime xlsx áp dụng các nguyên tắc lập mô hình mà người đọc kỳ vọng ở một bảng tính: một cuộc kiểm toán công thức không phụ thuộc backend (dùng chung bởi `issues` di động và bản rà soát chất lượng) báo tham chiếu trang tính nhiều từ không có dấu nháy, liên kết tới sổ làm việc ngoài, phần trăm lưu dạng số nguyên, năm có dấu phân cách hàng nghìn, và một con số lưu dạng văn bản cho mọi sổ làm việc (cộng, như thông tin, một trang tính dài có tiêu đề chưa cố định và một cột bảng gồm số ở định dạng General), và dưới `auditProfile:'financial-model'` một tỷ lệ viết thẳng trong công thức, một phép chia không bảo vệ, một công thức đơn lẻ phá vỡ mẫu hàng hoặc cột của nó, một tham chiếu đơn vượt quá phạm vi đã điền của trang tính (lỗi lệch một mà vẫn tính lại sạch), một hằng số cứng trong hàng công thức, và các đầu vào không phân biệt được với công thức, cộng với một đầu vào mà công thức đọc nhưng không có ghi chú nguồn và một phép đối chiếu trên trang Checks có giá trị FALSE — trên cả hai backend, vì `issues` của Excel giờ gộp cuộc kiểm toán chung vào các phát hiện của chính host. Snapshot hiển thị định dạng số, phông, màu và nền của từng ô có kiểu (các số nguyên BGR của Excel được chuẩn hóa về cùng dạng RRGGBB), ghi chú cũ theo từng ô và từng trang tính, bảng Excel theo từng trang tính (các bản ghi trong một bảng là dữ liệu mà bảng cung cấp, nên cuộc kiểm toán chỉ yêu cầu ghi chú ở các giả định ngoài nó), các vùng hợp nhất và ngăn cố định theo dạng của Excel, giá trị boolean là boolean, `defaultStyle` của sổ làm việc, và một bản tóm tắt `document.conventions` (phông mặc định, các phông đang dùng, định dạng số theo cột, dấu đầu vào, đầu vào mẫu) để một chỉnh sửa khớp với quy ước của chính tệp; `set_formula` đặt dấu nháy cho các tên trang tính nhiều từ mà sổ làm việc có (và, trên cả hai backend, mọi tên nhiều từ viết trước `!` và một tham chiếu) và báo `normalizedFormula`, việc tính lại của LibreOffice trả về `status` kèm `totalErrors`, một `errorSummary` theo loại lỗi và ô, và các `unparsedFormulas` mà LibreOffice ghi lại bằng chữ thường, và `finalize` từ chối một sổ làm việc có lần tính lại tìm thấy bất kỳ lỗi nào ngay cả khi bước rà soát bị bỏ qua. Kỹ năng viết lại các quy tắc của nó quanh không có lỗi công thức, công thức hơn kết quả dán, đặc tả nguyên văn, giả định có tài liệu, chú giải điền, và khớp quy ước của tệp có sẵn, với `references/model-conventions.md` cho màu, định dạng số, cấu trúc, trang Checks và nguồn dẫn.

- Kỹ năng pptx mở đầu bằng một bảng lộ trình — một bản trình bày mới là một script `author`, một bản có sẵn là `open` → `snapshot` → `batch`, và đọc là một `snapshot` phân trang hoặc trình trích xuất nguồn — và phân giải đường dẫn script của nó qua `${MIXDOG_SKILL_DIR}`, nên QC trang, bộ rà soát độc lập và `source-extract.mjs` (chuyển vào kỹ năng kèm một bài kiểm thử) chạy từ bất kỳ Dự án nào. Phần chỉnh sửa nêu các cạm bẫy mà runtime thực sự có: một slide nhân đôi dùng chung phần biểu đồ với nguồn của nó, trang trí mẫu vẫn ở nơi số dòng của placeholder đặt nó, và một script khai báo `pres` riêng thừa hưởng canvas 10 × 5.625 in của pptxgenjs. Các kỹ năng docx, xlsx và pdf thêm các cụm kích hoạt mà người dùng thực sự viết ("Word", "Excel", "PDF 읽어", "PDF 만들어"), và kỹ năng docx nói một snapshot hiển thị ngắt dòng như thế nào.

- Chỉnh sửa PowerPoint bằng backend đa nền tảng phân giải đích quan hệ của biểu đồ như gói làm: pptxgenjs ghi nó là tên phần tuyệt đối (`/ppt/charts/chart1.xml`), điều mà `set_chart_data` và các thao tác biểu đồ khác trên một bản trình bày đã soạn từng báo là thiếu phần. Các snapshot của backend đa nền tảng giờ giữ ngắt dòng và cuối đoạn là ký tự xuống dòng — văn bản hình và ghi chú của bản trình bày, và văn bản đoạn, ô, bình luận, bản sửa, ghi chú và điều khiển nội dung của tài liệu Word — thay vì dính "4주차" và "잔존율" lại với nhau.

- Các thanh tab của ngăn tạo hiệu ứng khi thêm và đóng theo đồng hồ chrome: một tab mới lớn dần từ không trong khi các tab lân cận co lại, nên dãy không bao giờ tràn thanh rồi trượt lùi, và một tab đã đóng thu gọn tại chỗ trong khi các tab còn lại lướt vào chỗ của nó thay vì nhảy. Một bản nháp được nâng thành phiên của nó vẫn đổi ngay lập tức, và thanh bỏ trạng thái giữ độ rộng không dùng.

- Việc soạn Office có thêm ba cấu trúc chất lượng đầu ra: `author` và `batch` trả về một `audit` đã đo (vừa khít, biên, tương phản, khoảng cách, gói) với số lượng theo từng slide và một yêu cầu sửa ngay trong lượt có đếm số vòng; `author` từ chối tạo bản trình bày có số liệu không được chứng minh bằng dữ kiện (`facts_gate`) trừ khi bản tóm tắt khai báo `facts: sample`, điều giữ lời công bố số liệu minh họa xuyên suốt qa và finalize; và kỹ năng pptx đi kèm `scripts/qc-pages.mjs`, một bộ sửa theo từng trang chạy một phiên mới cho mỗi slide chỉ với công cụ office và chỉ nhận bản sao làm việc của nó khi các lỗi đã đo của trang không tăng và không slide nào khác thay đổi.

- Các kỹ năng tách dòng liệt kê của chúng thành một mô tả một câu và một cụm kích hoạt `when_to_use`; danh sách kỹ năng của mô hình hiển thị `description — trigger` cắt ở 250 ký tự, trình soạn thảo kỹ năng có thêm một trường Điều kiện kích hoạt riêng, bộ xác thực skill-creator cảnh báo khi một dòng liệt kê sẽ bị cắt, và mọi kỹ năng tích hợp được viết lại theo dạng mới.

- Đảo Mục tiêu của phiên căn danh sách tác vụ với tiêu đề đã thu gọn, ngăn các hàng bằng đường kẻ mảnh, và thu gọn khi nhấp ra ngoài hoặc nhấn Escape.

- Bề mặt điện thoại theo chrome của desktop: đồng hồ ngữ cảnh nằm cạnh nút chọn mô hình của ô soạn thảo, các dấu thanh công cụ dùng chung họ lucide, và bảng bên phải mở như một đơn vị dock với tiêu đề mang cùng các nút chuyển chế độ xem như thanh trên desktop.

- Các kỹ năng tích hợp được phát hành từ một nguồn kỹ năng đi kèm, và các hướng dẫn Office trở thành các kỹ năng pptx, docx, xlsx và pdf được điều khiển bởi tính năng mà chúng vận hành. Cài đặt nhóm các kỹ năng phụ thuộc, máy chủ MCP và hook dưới plugin hoặc tính năng tích hợp của chúng.

- Office soạn các bản trình bày PPTX từ các script pptxgenjs với hướng dẫn thiết kế, bộ helper, menu bố cục và QC hình ảnh do mô hình dẫn dắt, và chịu được sự khác biệt về thứ tự phần tử con của bản trình bày và biểu đồ.

- Các lệnh gọi công cụ ép các đối số văn bản JSON về dạng schema đã khai báo, kể cả schema đăng ký nội bộ.

- Browser Use tách chính sách URL, tab, phân vùng, che giấu và script snapshot thành các module chuyên biệt; Computer Use tinh chỉnh mô hình lớp phủ, backend đầu vào và điều phối phiên.

- Khởi động trước desktop, khôi phục dock bên, thời điểm đặt lại mức dùng, các tệp khám phá do bridge sở hữu và khôi phục truyền tải phiên giữ cho khởi động nguội và kết nối lại luôn nhanh. Các bản triển khai FastDirect khởi động trước runtime đã cài.

- Trình chạy kiểm thử tách các tầng nhanh, chậm và live kèm báo cáo thời gian; các kho phiên lưu đệm tóm tắt bản ghi hội thoại và các lần quét danh sách; các tiện ích yêu cầu nhà cung cấp củng cố xử lý giao thức Anthropic, Cursor và OpenCode.

## v0.9.160 - 2026-09-02

- TUI giờ cài runtime Ink đã vá của nó từ một asset phát hành có phiên bản. Các bản dựng production, harness khung hình và các thăm dò tải phân giải gói đã cài trong khi giữ hành vi con trỏ, vùng chọn và kết xuất tùy chỉnh.

- Khởi động desktop giờ hiện các khung ngăn dùng được trước khi việc nạp danh mục và runtime chậm hơn hoàn tất. Các bề mặt Trình duyệt, Terminal, Trình soạn thảo và dock bên khôi phục độc lập, với các thăm dò sẵn sàng tập trung và các dịch vụ host trì hoãn giữ cho khởi động nguội luôn nhanh.

- Browser Use và Computer Use giờ có các module host theo vai trò thay vì các khối nguyên khối phẳng. Các hành động browser dùng chung định tuyến tường minh, vòng đời guest và hợp đồng phản hồi với xử lý hộp chọn tệp và hộp thoại mạnh hơn, còn Computer Use tách các trách nhiệm khám phá, quan sát, đầu vào, phiên, lớp phủ và backend với phạm vi an toàn được mở rộng.

- Các module runtime Office được tổ chức theo vai trò core, design, quality, portable, PDF, COM và benchmark. Bố cục tự do, chọn bố cục theo tham chiếu, cảnh PowerPoint đã soạn và các kiểm tra đảm bảo đã kết xuất cải thiện chất lượng hình ảnh mà không làm yếu đầu ra có thể chỉnh sửa hay ranh giới giao dịch.

- Các phiên Anthropic OAuth giờ học phiên bản CLI tối thiểu mà nhà cung cấp yêu cầu, chỉ lưu các cập nhật nâng lên an toàn, và thử lại yêu cầu bị từ chối một lần mà không ghi đè cấu hình phiên bản tường minh.

## v0.9.159 - 2026-09-01

- Kiểm tra nghiệm thu phát hành Windows giờ kiểm tra bản kiểm kê cài đặt chuẩn 16 mục thay vì số đếm cũ trước khi có điều hướng.

- Computer Use giờ điều phối các lease mục tiêu nền trước, chụp lại sau khi chuyển cửa sổ, xác thực các chuỗi hành động có giới hạn, và hiển thị một lớp phủ người dùng giành quyền. Các đường chụp, bàn phím, nhắm mục tiêu và khôi phục được tách thành các module tập trung với phạm vi host và bridge rộng hơn.

- Browser Use có thêm các sổ đăng ký theo phạm vi phiên và các bề mặt bền vững theo từng cuộc hội thoại. Các chế độ xem trình duyệt, diff và tiện ích có thể vẫn gắn với dock bên của mỗi cuộc hội thoại, trong khi việc đọc tệp cục bộ thay thế đường trình khám phá thư mục trùng lặp đã loại bỏ.

- Thu gọn ngữ cảnh mới giờ mang một bản bàn giao Ghi nhớ có giới hạn, giữ trạng thái tiếp tục của lượt đang hoạt động và phong bì công cụ, và giữ bố cục cache nhà cung cấp ổn định qua thu gọn. Việc nạp ghi nhớ chiếu bản ghi hội thoại đã thu gọn một cách nhất quán thay vì dựa vào đường fast-track đã loại bỏ.

- Việc tạo bản trình bày Office thêm định hướng sáng tạo, ngữ pháp bố cục, luồng hình ảnh ngữ nghĩa, rà soát thẩm mỹ đã kết xuất và điểm chất lượng phát hành để đầu ra bản trình bày đa dạng hơn và phát hiện bố cục yếu sớm hơn.

- Sự xáo trộn của hạ tầng xác minh và phát hành giảm mạnh: khối tool-smoke 3,500 dòng giờ là mười bốn suite `node --test` tập trung dưới `scripts/tool-contracts/` với các khẳng định nguyên văn dễ vỡ được nới thành hợp đồng cụm từ khóa, việc chọn đường dẫn CI có một nguồn duy nhất trong `scripts/release-paths.mjs` cho cả cổng phát hành và lập kế hoạch triển khai, và một bản phát hành bỏ qua việc chạy lại làn critical khi cổng đã xác minh đúng các commit đó.

- Không suite nào còn có thể mục nát trong im lặng: các khối kiểm thử còn lại (provider-toolcall, session-transport, shell-hardening) là các suite theo miền dưới `scripts/`, cổng phát hành giờ thực thi các hợp đồng tool-contract và compaction (recall-fasttrack) trên mọi lần push có cổng, và một đợt quét `suite-health` hàng tuần chạy mọi script `test:*`/`smoke:*` đã đăng ký qua một danh mục opt-out và mở một issue theo dõi khi thất bại.

## v0.9.158 - 2026-08-31

- Trung tâm Tiện ích mở rộng giờ cho Git, Ghi nhớ, Browser Use, Computer Use, Office và giọng nói một luồng cài đặt, tiến trình, bật và tắt nhất quán. Các runtime tùy chọn được chuẩn bị theo yêu cầu, Office có thể cài LibreOffice qua trình quản lý gói của nền tảng, và tắt giọng nói giữ lại các asset đã tải.
- Đóng gói runtime desktop nhỏ hơn và xác định hơn: các payload tính năng tùy chọn nằm ngoài ứng dụng cơ bản, mã runtime được chuẩn bị một lần, các bản triển khai snapshot chịu được chỉnh sửa đồng thời, và CI phát hành dùng chung một bản dựng runtime đa nền tảng với các cổng Git và Computer Use tường minh.
- Studio giữ các bản nháp theo từng mục và làm cho việc chỉnh sửa chi tiết, chọn và tương tác bàn phím bền vững qua điều hướng. Các điều khiển mức dùng ngữ cảnh và đọc chính tả giọng nói cũng báo trạng thái hiện tại nhất quán hơn.
- Tuyến OpenAI OAuth để tắt việc khởi động trước prompt qua WebSocket theo mặc định, tránh một yêu cầu khởi động không cần thiết trừ khi được bật tường minh.
- Terminal-Bench 2.1 công bố toàn bộ so sánh Codex CLI `k=5` với các artifact Harbor thô, xác minh commit nguồn, nguồn gốc chi phí đã khôi phục và việc tạo báo cáo có thể tái lập.

## v0.9.157 - 2026-08-31

- Browser Use có một cách chia host nhỏ hơn, đáng tin cậy hơn qua tab, tải xuống, chặn bắt, quyền, snapshot, báo cáo hộp thoại và vòng đời trang. Việc nhập hồ sơ Chromium giờ gồm giải mã cookie App-Bound v20 ngoại tuyến qua trình nhập gốc đóng gói mà không để lộ bí mật đã giải mã cho renderer hay agent.
- Computer Use được phân rã thành các module chụp, khám phá, nhắm mục tiêu, quan sát, đầu vào và worker có giới hạn. Quyền sở hữu tài nguyên công bằng hơn, trạng thái sau hành động mới hơn, bảo vệ đầu vào chặt hơn và các kịch bản lặp được mở rộng làm cho các phiên gốc và Chromium chạy lâu nhanh hơn và an toàn hơn.
- Ghi nhớ chuyển sang runtime embedding E5 gọn với nạp bù tăng dần mới nhất trước, nén và lưu giữ cache, xếp hạng từ vựng nhận biết tiếng Hàn và thu hồi worker nhàn rỗi. Addon gốc token cũ và đường mô hình cũ nặng hơn bị loại khỏi runtime phát hành.
- Khôi phục phiên nâng nhật ký checkpoint thành ranh giới tiếp tục bền vững, giữ mức dùng của nhà cung cấp, các neo thu gọn, bàn giao truy hồi và phát lại suy nghĩ của Anthropic qua gián đoạn, thử lại và khởi động lại mà không nhân đôi ngữ cảnh.
- Việc soạn Office thêm các kế hoạch bố cục do mô hình soạn, một thư viện thiết kế tái sử dụng, xem trước tài liệu và các nguyên thủy Word, Excel và PowerPoint di động rộng hơn trong khi vẫn giữ các kiểm tra đảm bảo cấu trúc và đã kết xuất.
- Các bề mặt web desktop và di động có thêm Browser Use từ xa, tiếp nhận share-target, thông báo đẩy, chỉnh sửa và xem trước tài liệu phong phú hơn, khôi phục khi khởi động yên tĩnh hơn, và cập nhật cache service worker dễ đoán hơn.
- Tìm kiếm gốc giờ giới hạn các lease kiểm kê rộng và tiếp nhận công bằng các công việc find, glob và grep đồng thời. Tự động hóa phát hành dựng lại tăng dần các asset gốc và giọng nói đã thay đổi, xác minh các sidecar đóng gói, và tái sử dụng các artifact runtime nền tảng không đổi.

## v0.9.156 - 2026-08-29

- Việc soạn Office di động có thêm kết xuất biểu đồ và số đo văn bản, nên nhiều công việc PPTX và XLSX hoàn tất hơn mà không phải bàn giao cho host Office COM.
- Các hợp đồng công cụ Browser Use và Computer Use được sửa đổi cùng với kho cài đặt desktop, xác thực IPC và định dạng công cụ trong bản ghi hội thoại.
- Cuộn ảo của desktop giờ theo các gói upstream, và việc ghim đáy của bản ghi hội thoại dựa vào cơ chế trì hoãn cuộn của chính core.
- Các bản triển khai phát triển có thể chạy từ một snapshot đóng băng của cây làm việc (`update:dev:snapshot`), cho phép một lần cài thành công trong khi các phiên khác vẫn chỉnh sửa kho thay vì thất bại ở kiểm tra dấu vân tay đầu vào.

## v0.9.155 - 2026-08-29

- Nhập slide PPTX, thay hình ảnh và soạn dữ liệu bảng giờ chạy trong engine di động, nên các thao tác đó không còn cần host Office COM.
- Việc soạn Office có thêm các module đóng gói, bố cục, kiểu trang tính và hình slide di động đằng sau quy trình đảm bảo và chất lượng hiện có.
- Theo dõi Goal có thêm xử lý lời nhắc và trích xuất văn bản cho các lượt tiếp tục, và desktop giữ siêu dữ liệu phiên đồng bộ với một ngân sách cache renderer có giới hạn cho trạng thái phiên chưa đọc.

## v0.9.154 - 2026-08-29

- Các phiên Computer Use được thu hồi trên mọi đường thoát thay vì phụ thuộc vào bộ hẹn giờ unref mà một runtime đang rời đi không bao giờ kích hoạt: tắt daemon và worker giải phóng chúng, một phiên đang đóng giải phóng phiên của chính nó, các worker host nhàn rỗi hết hạn theo cùng đồng hồ với các quyền giữ cửa sổ mà chúng nắm, và một kết nối client bị ngắt sẽ hủy đầu vào đang chạy thay vì để nó điều khiển desktop cho đến hết thời gian lệnh. Client cũng thử lại một lần với bridge được công bố lại, nên khởi động lại ứng dụng desktop không còn làm lệnh kế tiếp thất bại ngay.
- Một trang Browser Use bị sập khôi phục ở lệnh kế tiếp thay vì làm nó thất bại. Các ref gắn với tài liệu đã chết bị bỏ cùng nó, nên việc khôi phục không bao giờ có thể trả lại tọa độ từ một trang không còn tồn tại.
- Thu gọn chạy giữa một prompt và yêu cầu tới nhà cung cấp không còn bị treo khi runtime ghi nhớ bị đình trệ: lệnh gọi ghi nhớ recall-fasttrack được giới hạn cho mọi bên gọi, không chỉ đường duy nhất tình cờ gắn thời gian chờ.
- Trình phân tích mục ẩn của Windows Explorer tách đầu ra attrib.exe theo quy tắc đường dẫn Windows trên mọi host, và thăm dò khả năng commit-hook giờ hoạt động qua các phiên bản git bất đồng về việc tên hook không gốc có cần cờ hay không.
- Deploy ngừng dựng lại các runtime nền tảng giống hệt từng byte. Mã nguồn kiểm thử rời cả gói đã xuất bản và khóa cache runtime, nên một thay đổi chỉ ở kiểm thử trúng cache runtime đã chuẩn bị thay vì trả giá bảy phút dựng lại trên Windows. Các suite desktop chạy như các job cổng song song, gồm một nhánh Windows cuối cùng đã chạy Computer Use trong CI, và suite git 240 giây không còn nằm trong lần chạy cục bộ mặc định.

## v0.9.153 - 2026-08-28

- Computer Use trên Windows giờ chạy một vòng quan sát kiểu CUA nhỏ hơn: khả năng truy cập gọn và ảnh chụp màn hình thuần được trả về cùng nhau theo mặc định, trạng thái sau hành động được làm mới ngay lập tức, AX và OCR dự phòng dùng chung một ngân sách phần tử nghiêm ngặt, các bản chụp đen, trắng hoặc không khớp không dùng được không bao giờ phát khung tọa độ, các thay đổi làm mất hiệu lực các khung pixel trước đó, một popup mới cùng tiến trình trở thành mục tiêu xác minh xác định, các trường văn bản Electron do ứng dụng sở hữu dùng cách chèn nền gốc của renderer, việc khôi phục nêu tên một nấc leo thang kế tiếp, và các phím kết thúc phiên nguy hiểm, payload shell, hoặc việc khởi chạy shell/script-host bị chặn ở ranh giới host. Một dashboard Windows 23 kịch bản giờ bao phủ các đường gốc, Electron, Chrome, OCR tiếng Hàn, màn hình phụ, trạng thái cũ, focus, popup, an toàn và dọn dẹp.
- Các quan sát và lượt của Computer Use nhanh hơn mà không làm yếu ranh giới đầu vào: các snapshot chuyển tiếp/khung Win32 nhẹ, chụp đúng cửa sổ, khả năng truy cập Chromium hiện đại có giới hạn, thăm dò khởi chạy thích ứng, bảo vệ tài nguyên chụp, và khôi phục focus/con trỏ đã xác minh thay thế việc liệt kê toàn bộ ứng dụng lặp lại và các phương án dự phòng không giới hạn. Việc gõ nguyên văn nhắm vào phần tử có thể focus và gõ trong một hành động, và OCR có giới hạn có thể được đưa vào lần chụp bắt buộc sau hành động. Ma trận cuối 23 kịch bản × 10 host nguồn đạt 230/230 lần vượt ngữ nghĩa và giảm độ trễ kịch bản p50/p95 cơ sở 90.55%/94.01%; một ma trận stress riêng với mục tiêu dày đặc/thu nhỏ/cũ vượt 40/40. Toàn bộ 30 lần chụp lại thừa sau hành động đã bị loại bỏ, và số lệnh gọi giảm 36.84% trong năm quy trình hành động có thể gộp lô. Việc gộp lô thay đổi tùy ý vẫn chưa được hỗ trợ.
- Computer Use giờ cung cấp một hợp đồng 15 hành động nghiêm ngặt thay vì 28 hành động chồng chéo hoặc một schema trường tùy chọn phẳng. Quan sát/tìm kiếm/thu phóng dùng `capture`, vòng đời cửa sổ và clipboard dùng các trường thao tác, và một đối tượng `capture_after` dùng chung cấu hình việc xác minh tự động. Hướng dẫn theo tham chiếu yêu cầu các mục tiêu chính xác mới, ưu tiên các phần tử ngữ nghĩa, và giữ Browser Use tách biệt. Schema cuối là 2,644 token ước tính trước các phần mở rộng frontier; hợp đồng frontier trước khi loại bỏ vượt 36/36 kịch bản mô hình ở lần gọi đầu. Hợp đồng điều phối trực tiếp hiện tại là 3,210 token ước tính và 14,485 byte đường truyền. `diagnose` chỉ đọc báo mức sẵn sàng OCR/UIA của Windows mà không dùng pixel màn hình; `sequence` có giới hạn dừng khi thất bại hoặc chuyển mục tiêu và trả về một trạng thái mới cuối cùng; số lượng lệnh gọi nghiêm ngặt ngăn các thay đổi chéo mục tiêu song song cả trong hướng dẫn mô hình lẫn trước khi runtime điều phối háo hức. Các lệnh gọi `computer` thừa trong cùng lượt không được thực thi và nhận một lỗi khôi phục trạng thái mới. Chọn bằng ngôn ngữ tự nhiên vượt 4/4 chuỗi focus an toàn và 4/4 ranh giới chuyển tiếp. Trong 10 lần lặp, một lượt tiếp tục hai hành động dùng ít hơn 50% lệnh gọi và lần chụp hướng tới mô hình, với độ trễ p50/p95 giảm 12.34%/32.31%. Các lời nhắc xác nhận Computer Use và phê duyệt giao dịch Office hướng tới mô hình đã bị loại bỏ; các hành động do người dùng yêu cầu giờ thực thi trực tiếp trong khi các mẫu phím, payload và script-host bị chặn vẫn là lỗi cứng. Mức dùng nhà cung cấp đo được là 5,150 token đầu vào và 4,026 ms p50 mỗi lệnh gọi mô hình. Một schema sau quan sát 12 hành động giảm đầu vào 18.16% ở độ chính xác 27/27 nhưng bị loại vì các giá trị ngoại lai độ trễ lặp lại và thay đổi schema giữa vòng sẽ phá vỡ hợp đồng cache tiền tố nhà cung cấp bất biến. Các hành động ngữ nghĩa có chuyển tiếp cửa sổ chính xác xác định giờ báo xác minh đã xác nhận. Không còn phương án dự phòng dạng lệnh gọi cũ. Sau một lần triển khai phát triển, việc xác thực ứng dụng đã cài xác nhận rằng `click(ref)` bên trái dùng kích hoạt ngữ nghĩa và một lần khởi chạy liên kết tệp gốc trả về mục tiêu đã chọn của nó cùng trạng thái mới; các dấu và tọa độ vẫn là các thao tác con trỏ tường minh.
- Browser Use có thể nhập mật khẩu, cookie và lịch sử Chromium, chỉ gợi ý các tài khoản đã che cho nguồn HTTPS hiện tại, và điền một biểu mẫu đăng nhập đã chọn trong một thế giới CDP cô lập mà không để lộ mật khẩu đã lưu cho renderer, agent, chẩn đoán hay nhật ký. Tiện ích giờ mặc định ở tab bên phải đầu tiên, chuyển vị trí mặc định cũ mà không đặt lại các bố cục tùy chỉnh, và bao gồm điểm vào Browser.
- FastDirect giờ lấy dấu vân tay, chuẩn bị, sao lưu và khôi phục nguyên tử các sidecar gốc của trình nhập trình duyệt cùng với `runtime.asar`, nên các bản cập nhật phát triển gia tăng không thể để ứng dụng đã cài thiếu trình nhập.
- Mức dùng ngữ cảnh của phiên giờ ghi một snapshot chuẩn sau thu gọn, tồn tại qua lưu trữ và khởi động lại cho đến khi lượt kế tiếp làm nó mất hiệu lực. Trạng thái Goal và khôi phục thu gọn nhất quán qua các dịch vụ được khởi động lại thay vì vẽ lại mức dùng token cũ hoặc mất công việc có thể tiếp tục.
- Việc tạo Office giờ dùng chung một mô hình nội dung ngữ nghĩa, các kiểm tra đảm bảo cấu trúc và đã kết xuất, rà soát prompt-injection, các cổng danh sách kiểm và quy trình trau chuốt trên Word, Excel và PowerPoint. Các điều khiển trang/chế độ xem của bảng tính, chọn theo sức chứa mẫu, lưu dữ liệu biểu đồ gốc và xác minh lưu rồi mở lại trực tiếp củng cố các tài liệu chất lượng phát hành.

## v0.9.152 - 2026-08-27

- Chế độ Goal giờ có thể mang một mục tiêu chạy dài xuyên các lượt với điều kiện hoàn thành bền vững, điều khiển tạm dừng và tiếp tục, giới hạn thời gian, tự động tiếp tục, công cụ quản lý hướng tới mô hình, và một đảo trạng thái Desktop theo phạm vi phiên.
- Browser Use và Computer Use trên Windows có sẵn dưới dạng các khả năng tích hợp tùy chọn bật. Browser Use có thể kiểm tra và vận hành các trang trong ứng dụng hoặc ở nền, còn Computer Use kết hợp UI Automation, ảnh chụp màn hình, bàn phím, con trỏ, cuộn và các hành động cửa sổ với đầu vào nhận biết DPI và các bảo vệ an toàn.
- Khôi phục nhà cung cấp giờ giữ thứ tự ban đầu của suy luận, văn bản và lệnh gọi công cụ trên các luồng Anthropic, Gemini, OpenAI và tương thích, kể cả thử lại, lượt bị đình trệ, phiên đã lưu, chiếu từ xa và thu gọn.
- Thu gọn bắt đầu một kỷ nguyên cache đọc mới sau khi nó thay đổi bản ghi hội thoại, và các phiên hiện có đồng bộ các công cụ runtime mới có sẵn ở ranh giới lượt thay vì giữ một danh mục công cụ cũ.
- Điều hướng desktop và di động gọn gàng và dễ đoán hơn: các lần khởi chạy lại trên di động bắt đầu từ một Tác vụ mới trong khi kết nối lại giữ các ngăn hiện tại, thao tác vuốt ngăn hoạt động trên nội dung phong phú và lớp phủ, và các trang bên, tiện ích mở rộng, Markdown, nhãn trạng thái và các hành động cuối dòng dùng chung bố cục đáp ứng chặt chẽ hơn.

## v0.9.151 - 2026-08-26

- Chỉnh sửa một liên kết tượng trưng giờ thay đổi tệp mà nó trỏ tới thay vì bị từ chối: patch và edit đi theo liên kết qua mọi engine, ghi nguyên tử bên cạnh đích thực, và để nguyên chính liên kết.
- Các lần chạy headless và benchmark không còn để lại cơ sở dữ liệu và tiến trình tạm. Mỗi lần chạy có một gốc runtime cô lập, tắt máy chờ daemon phiên thay vì báo thành công trước nó, và các cụm mồ côi được quét dọn khi thoát.
- Thu gọn hội thoại giữ mọi thứ cần giữ. Thu gọn tự động, thủ công và đã xóa dùng chung một đường, bản tóm tắt đã lưu đứng đầu với toàn bộ lịch sử thô phía sau, và các lượt gần nhất được giữ nguyên văn thay vì bị cắt bởi giới hạn hàng hoặc kích thước.
- Thăm dò đọc tệp gốc trước khi quyết định cách phân tích, đếm hay tóm tắt nó, nên một phỏng đoán về định dạng không còn dẫn dắt câu trả lời.
- Trau chuốt desktop: hình ảnh đính kèm mở trong trình xem của hệ thống, các hàng hạn mức của bảng mức dùng đọc theo thứ tự tự nhiên, và các bảng ngữ cảnh và route mất các khung và viền focus còn sót lại.
- Kết quả Terminal-Bench 2.1 được công bố lại từ một lần chạy `k=5` của cả 89 tác vụ, với các artifact xác minh thô của mọi lần chạy đã công bố được commit cùng harness và các script chỉ số.

## v0.9.150 - 2026-08-25

- Kết quả công cụ dễ quét và trung thực về kích thước: đầu ra tìm kiếm và các lần read nhiều tệp giữ trong một ngân sách cố định thay vì làm ngập câu trả lời bằng hàng nghìn dòng, và một đường dẫn đơn giản là không tồn tại — hoặc một kết luận trạng thái kho thông thường — trả về như câu trả lời thay vì một lỗi đẩy trợ lý vào khôi phục.
- Các phiên không còn mang dấu vân tay nhà cung cấp cũ qua khởi động lại, và một tin nhắn mới đánh thức ngay một lượt đang chờ tác vụ nền, nên một câu trả lời hạ cánh thay vì nằm sau lần chờ.
- Chọn văn bản trong terminal khôi phục từ một lần kéo mà nút được thả ngoài cửa sổ, và một vùng chọn kéo qua mép trên hoặc dưới tuân theo hành vi đầu dòng và cuối dòng thông thường thay vì đứng yên ở cột cuối mà con trỏ giữ.
- Đọc chính tả bằng giọng nói hỏi xác nhận trước khi cài runtime của nó, thẻ công cụ và khung diff thẳng hàng theo giao diện chung, và mười ngôn ngữ giao diện được làm mới.

## v0.9.149 - 2026-08-24

- Các phiên OpenAI OAuth giờ nói theo dạng đường truyền của client tham chiếu theo mặc định: danh tính cài đặt và luồng ổn định, dạng yêu cầu nhẹ hơn trên các mô hình hiện tại, và xử lý đúng chuẩn nhà cung cấp một socket chạm giới hạn tuổi thọ giữa phiên.
- Khởi động phiên chỉ dành kết nối đã khởi động trước cho lượt đầu khi prompt nó đã khởi động vẫn khớp, nên một lượt có môi trường hoặc bề mặt công cụ đã thay đổi bắt đầu sạch thay vì gửi lại cả yêu cầu.
- Danh sách thư mục trả về một trang đầu có kích thước phù hợp để quét thay vì một bản đổ, và tra cứu cấu trúc mã chỉ lấy toàn bộ nội dung ký hiệu khi cần đúng bản triển khai.

## v0.9.148 - 2026-08-24

- Các cuộc hội thoại desktop và di động giữ bản nháp, lịch sử, hành vi theo dõi, cử chỉ ngăn và trạng thái từ xa đáng tin cậy hơn trong khi giảm lượng truyền relay và chi phí triển khai renderer.
- Các phiên agent khôi phục luồng nhà cung cấp, thu gọn, trạng thái worker và kết quả công cụ nhất quán hơn, với kết quả xung đột Git và môi trường rõ ràng hơn và đo từ xa tìm kiếm chính xác hơn.
- Đầu vào giọng nói có thêm đường phát hành runtime đa nền tảng đã xác minh, trong khi truy xuất ghi nhớ, xử lý tiến trình gốc và chuẩn bị runtime đóng gói được củng cố.
- Tự động hóa phát hành, triển khai FastDirect và báo cáo benchmark giờ tái sử dụng các artifact không đổi và so sánh các lệnh gọi mô hình, chi phí và ngữ cảnh cuối với cách tính đúng chuẩn nhà cung cấp.

## v0.9.147 - 2026-08-21

- Các phiên OpenAI dài giờ giữ nguyên chuỗi phản hồi và ghim trạng thái lượt qua kết nối lại, sắp xếp lại mục và thu gọn, nên cache tiền tố của nhà cung cấp sống sót qua một phiên thay vì khởi động lại giữa tác vụ.
- Khởi động phiên khởi động trước tiền tố nhà cung cấp và tách chi tiết môi trường khỏi tiền tố hướng dẫn dùng chung, cắt giảm khởi động nguội và việc tải lên lặp lại ngữ cảnh giống hệt.
- Các quy tắc dùng công cụ đọc ngắn hơn với cùng các đảm bảo: các mệnh đề định tuyến giờ biến mất cùng các công cụ mà chúng nêu tên, và kết quả shell được phân loại theo trình chạy đã tạo ra chúng.
- Thẻ công cụ và tóm tắt kết quả trên desktop được bản địa hóa, và đồng hồ ngữ cảnh báo ước tính sau thu gọn thay vì tiền tố đã bỏ.
- Các lần chạy benchmark có thêm preset route nhanh và một bộ điều hợp tham chiếu grok CLI, nên các con số tham chiếu đến từ cùng các container và bộ xác minh.

## v0.9.146 - 2026-08-21

- Các cuộc hội thoại web di động giờ giữ ổn định cuộn cảm ứng, đo Markdown đang phát, vuốt tab, điều khiển ô soạn thảo gọn và lớp phủ đáp ứng qua các cử chỉ gốc, xoay màn hình và bố cục màn hình nhỏ.
- Các phiên có thể mang cả một cuộc hội thoại vào mô hình đang chọn khi nó vừa ranh giới ngữ cảnh của mô hình đó, trong khi mức dùng ngữ cảnh và chi tiết route kế thừa vẫn tường minh.
- Các nhóm công cụ trong bản ghi hội thoại giữ nguyên các lệnh gọi, đối số, đầu ra và trạng thái hoàn thành gốc để kiểm tra chi tiết, với bản xem trước hình ảnh được bản địa hóa và cách trình bày hoạt động rõ ràng hơn.

## v0.9.145 - 2026-08-21

- Các phiên web di động giờ giữ ổn định tỷ lệ viewport gốc, khôi phục ghép nối, chiếu trạng thái từ xa và cuộn bản ghi hội thoại qua cử chỉ chạm, đo hàng khi phát, khôi phục ứng dụng và kết nối chậm.
- Các ngăn desktop, làm mới quản lý mã nguồn, hoạt động công cụ, bề mặt lệnh và trạng thái phiên khôi phục nhất quán hơn trong khi giữ bố cục đáp ứng và phản hồi tải hoặc gián đoạn rõ ràng hơn.
- Định tuyến công cụ agent giờ áp dụng các bảo vệ đối số chặt hơn, chính sách thay đổi Git, xử lý tiền tố nhà cung cấp, chiếu bằng chứng và khôi phục đầu ra shell trên runtime dùng chung và TUI.
- Các công cụ phát hành, benchmark, bản địa hóa và chẩn đoán giờ xác thực hợp đồng của chúng với phạm vi kiểm thử hồi quy rộng hơn và các báo cáo runtime gọn hơn.

## v0.9.144 - 2026-08-21

- Tương tác desktop giờ theo focus bàn phím và con trỏ đáng tin cậy hơn, cải thiện vuốt ngăn trên di động và cách trình bày bản ghi hội thoại/trạng thái, và báo trạng thái tác vụ shell nền với hành vi khôi phục an toàn hơn.
- Các ngăn Git diff hiện trạng thái tải của chính chúng ngay lập tức, gộp các lần làm mới chồng lấn, và kết xuất văn bản kho mà không gọi các lệnh diff hoặc textconv ngoài đã cấu hình.
- Solo giờ là quy trình mặc định, các quy tắc dùng công cụ giữ bằng chứng trong khi gộp lô công việc chặt hơn, và các cửa sổ read/grep có giới hạn giảm ngữ cảnh không cần thiết mà không che phân trang.

## v0.9.143 - 2026-08-20

- Thực thi phiên giờ dùng chung một worker runtime có giám sát thay vì một nhóm phân mảnh tiến trình. Các agent nền ở trong cùng tiến trình, việc chờ nhà cung cấp nhường khe cho phép CPU cục bộ của chúng, và các giới hạn sinh tiến trình toàn máy cùng khôi phục sức khỏe runtime vẫn được thực thi.
- Phê duyệt thiết bị từ xa chỉ xuất hiện khi Cài đặt → Kết nối đang mở, khôi phục các yêu cầu đang chờ khi bảng đó mở, và chỉ hoàn tất sau khi trình duyệt chứng minh kết nối E2EE đã xác thực của nó.

## v0.9.142 - 2026-08-20

- Đóng gói desktop Linux xác thực kiến trúc đích trong thư mục prebuild ABI mà `node-pty` thực sự nạp, trong khi các gói Windows và macOS đã biên dịch giữ đường xác thực `build/Release` của chúng.

- Các ứng dụng web đã cài tiếp tục một phê duyệt desktop đang chờ qua các lần tải lại, trong khi desktop thay thế các lời nhắc cũ, làm chúng hết hạn cùng yêu cầu relay, và chỉ chấp nhận mỗi quyết định sau khi dịch vụ xác nhận.
- FastDirect tái sử dụng các đích dựng mới, một cache renderer production bền vững, đầu ra runtime đã chuẩn bị và một mẫu vỏ ASAR đã giải nén. Các bản triển khai relay trực tiếp lấy dấu vân tay độc lập các thay đổi renderer/máy chủ và chỉ tải lên các delta renderer đã xác minh trước khi hoán đổi VPS nguyên tử.
- Mã nội dòng theo phông chữ và kích thước của văn xuôi xung quanh, chỉ để màu làm điểm phân biệt nội dòng duy nhất trong khi mã có rào vẫn là monospace.

## v0.9.141 - 2026-08-20

- Việc tạo tác vụ trên desktop hoạt động dưới Electron 41 và Node 24: bộ định tuyến shard agent giờ sao chép các export ESM bất biến của trình quản lý phiên vào một facade có thể ghi trước khi cài các ghi đè phiên từ xa của nó.

## v0.9.140 - 2026-08-20

- Xóa trong Studio có hiệu lực ngay lần nhấp đầu: một lần chạy đã xong giải phóng khe lưới ngay khi asset của nó được lập chỉ mục, nên xóa asset đó không còn làm sống lại khe như một ô "generating" ma. Thư viện không còn bị giới hạn 2,000 mục — một asset chỉ rời kho qua một lệnh xóa tường minh — và một lần chạy thất bại, bắt đầu mà không có job, hoặc mất snapshot runtime giờ báo điều đó thay vì quay vòng im lặng.
- Bộ chuyển tab di động hiển thị như một lưới thẻ và chỉ có ô lọc khi danh sách đủ dài để cần, trong khi chrome điện thoại trình bày lại các đĩa ô soạn thảo, đảo trạng thái và các bảng theo tỷ lệ cảm ứng và đưa các điều khiển chỉ hiện khi di chuột vào tầm với.
- Một ứng dụng web đã cài có thể tự ghép nối: nó mở một URL vào định tuyến theo thiết bị, xin desktop đó phê duyệt đằng sau một mã hai chữ số hiển thị trên cả hai màn hình, và nhận tài liệu ghép nối được niêm phong theo khóa dùng một lần của chính nó. Các trình duyệt đã ghép nối giờ đăng ký các làn đẩy mà chúng đọc, nên một điện thoại đã kết nối không còn phải trả giá cho lưu lượng terminal, trình soạn thảo và tệp mà nó không bao giờ hiển thị.
- Máy chủ tìm kiếm code-graph phục vụ các client pipe dùng chung bằng hàng đợi phản hồi theo từng kết nối và id yêu cầu theo phạm vi client, và tự thoát sau một khoảng nhàn rỗi để một chủ bị buộc dừng không còn để lại các máy chủ đã khởi động.
- Các lệnh gọi công cụ sống sót qua nhiễu đối số của nhà cung cấp: một đường dẫn gốc tùy chọn bị bỏ sót phân giải về Dự án hiện tại thay vì làm lệnh gọi thất bại, đối số task được thu hẹp theo hành động đã chọn, và đầu ra git giữ khung tiến trình cuối cùng và dòng fatal ở cuối thay vì chôn lý do dưới các khung vẽ lại.
- Renderer nạp một danh mục ngôn ngữ giao diện thay vì mười một, chốt ngôn ngữ trước khi module ứng dụng đầu tiên được đánh giá, và tải trước một chunk bề mặt khi chọn; /inherit đưa một cuộc hội thoại hiện có vào một phiên mới trên route đang chọn.
- Ghi công bên thứ ba chỉ do LICENSES và NOTICE đảm nhiệm.

## v0.9.139 - 2026-08-20

- Antigravity OAuth xuất hiện như một nhà cung cấp: một lần đăng nhập Google mở ra Gemini 3.x và Claude qua cổng Cloud Code Assist, với đăng nhập, làm mới token và failover endpoint theo dạng nhà cung cấp OAuth hiện có.
- Agent giờ có đúng hai trạng thái, một mô hình được ghim hoặc tắt, và Tìm kiếm web phân giải Mô hình Main khi route của nó để trống.
- Các trình duyệt đã ghép nối tiếp cận bề mặt thao tác desktop — hướng dẫn dự án, duyệt thư mục và địa điểm, và hợp đồng git — qua một module xác thực đối số dùng chung, trong khi trạng thái phiên relay đi dưới dạng các delta gọn theo phạm vi client bên trong khung E2EE nhị phân.
- Ứng dụng web giờ phát hành các asset brotli và gzip nén sẵn, giữ lại các lần khởi động trước nền và phông chữ trên kết nối có tính phí hoặc chậm, đổi kích thước ảnh đính kèm và âm thanh đọc chính tả trước khi tải lên, bỏ hiệu ứng làm mờ trực tiếp của đảo trạng thái đã ghim trên điện thoại, và vẽ màu nhấn thương hiệu bằng xanh Google.
- Việc chuẩn bị runtime Windows và đóng gói asar sống sót qua các script vòng đời của kho và các khóa tệp tạm thời của phần mềm diệt virus, và dòng trạng thái TUI tính số shell đang chạy trực tiếp trên đường tức thời.

## v0.9.138 - 2026-08-19

- Các phiên web từ xa giờ dùng đăng ký theo phạm vi client, khung E2EE nhị phân, các delta trạng thái/danh mục gọn, gộp lô terminal và các thăm dò độ trễ vẽ, giảm lượng truyền trong khi vẫn giữ khôi phục trực tiếp trên kết nối chậm.
- Cuộn bản ghi hội thoại web và đầu vào ô soạn thảo vẫn ổn định về mặt thị giác trong các snapshot từ xa đồng thời, chuyển phiên và kết xuất trên di động.
- Ngữ cảnh runtime, khôi phục yêu cầu nhà cung cấp, thông báo tác vụ nền và khôi phục hoàn tất được củng cố qua các phiên chạy dài.

## v0.9.137 - 2026-08-19

- Khôi phục kết nối lại từ xa giờ làm mới các danh mục phiên và các làn bản ghi hội thoại đã gắn, và nút cập nhật đứng đầu nhóm nút trên thanh tiêu đề.

## v0.9.136 - 2026-08-19

- Hạ tầng nhắn tin Discord/Telegram và phiên kênh đã loại bỏ được gỡ bỏ, trong khi các thanh hệ thống trên di động vẫn luôn màu đen.

## v0.9.135 - 2026-08-18

- Desktop giờ giữ bố cục ngăn, trạng thái thanh bên, hình học bảng và bản nháp ô soạn thảo qua các lần tải lại và khởi động lại FastDirect, với phạm vi kiểm thử hồi quy renderer mở rộng.
- Thực thi shell giờ củng cố việc làm sạch môi trường, chờ sẵn sàng, khôi phục hoàn tất nền, xử lý tiến trình gốc và định tuyến công cụ qua các phiên tương tác và headless.
- Các bản phát hành Linux của native spawn được liên kết tĩnh, tìm kiếm graph và báo cáo recall được củng cố, và định tuyến Terminal Bench cùng công cụ báo cáo được cập nhật.

## v0.9.134 - 2026-08-17

- Desktop giờ phát hành dấu thương hiệu đã chọn, một trình soạn thảo route mô hình hợp nhất với tham số mô hình và thứ tự danh sách được lưu, và giải nén node-pty bên cạnh daemon đóng gói.
- Thu gọn phiên bị khóa cứng theo chủ sở hữu: các phiên agent giữ ngữ nghĩa, các phiên người dùng dùng recall-fasttrack. Cài đặt không còn liệt kê Ký ức cốt lõi (chúng nằm trên dự án), và bản kiểm kê nghiệm thu Windows khớp theo.

- Các tích hợp nhà cung cấp và công cụ giờ gồm vòng đời OAuth và khôi phục token trên Anthropic, Cursor, Grok và OpenAI, chuẩn hóa schema công cụ riêng của Grok, và việc tản đường dẫn/mẫu của tìm kiếm và grep được phân rã.
- Điều phối phiên và quy trình TUI giờ thực thi phạm vi theo phiên chủ sở hữu, giữ các thẻ bàn giao đã hoàn tất và hoàn tất nền qua các lần khôi phục, giữ các prompt đã đưa ra ngoài trong hàng đợi, và phân loại kết quả giữa lỗi lệnh, lỗi công cụ và các lần trượt vô hại.
- Điều hướng không gian làm việc desktop giờ giữ tiêu đề phiên của ngăn trong khi kéo thả, thêm các lần thử lại khôi phục không gian làm việc khi khởi động nguội để ngăn mất tab, và cập nhật các bảng hướng dẫn làm quen và cấu hình khả năng.

## v0.9.133 - 2026-08-16

- Chiếu bằng chứng chỉ-nhà-cung-cấp giờ đặt bí danh cho các đường dẫn tệp có kiểu lặp lại trong các kỷ nguyên thay đổi, giữ nguyên phong bì công cụ chính xác và các đường dẫn có thể dựng lại trong khi giảm ngữ cảnh tích lũy trong các phiên dài.
- Thực thi Git giờ dùng chung một chính sách thay đổi qua điều phối và chiếu bằng chứng, tuần tự hóa các lần ghi toàn kho với các chỉnh sửa tệp, dùng các tiến trình gốc do cây sở hữu, và làm các khóa trong hàng đợi có thể hủy.

## v0.9.132 - 2026-08-16

- Thực thi công cụ giờ hiển thị đầy đủ trạng thái thoát của shell, thêm một bề mặt Git chuyên dụng, củng cố việc tạo patch nguyên tử và chẩn đoán, và cải thiện tính toàn vẹn của tìm kiếm, liệt kê, code-graph và graph gốc dưới tải đồng thời.
- Thu gọn phiên, khôi phục nhà cung cấp/hình ảnh, theo dõi bằng chứng, sức khỏe shard và dọn dẹp runtime Lead giờ giữ trạng thái qua các lỗi mà không che các worker suy giảm hoặc kích hoạt công việc dự phòng không cần thiết.
- Định tuyến desktop, hoạt động agent, trạng thái ngăn đã khôi phục và kết xuất Markdown đang phát giờ vẫn phản hồi nhanh và nhất quán về mặt thị giác qua các cuộc hội thoại trực tiếp và đã tiếp tục.

## v0.9.131 - 2026-08-14

- Các cổng phát hành giờ chạy tự động với việc chọn đường dẫn gia tăng, các runtime nền tảng desktop được chuẩn bị trước khi đóng gói, các bản dựng graph gốc dùng một hồ sơ nhanh hơn có thể tái lập, và triển khai web/relay production gồm khôi phục nguyên tử cùng xác minh hash và sức khỏe.
- Các làn phát hành desktop giờ đóng gói ngay khi runtime tương ứng sẵn sàng, các cache trình biên dịch graph được cô lập giữa các bản dựng tái lập, các lần cài relay được ghim theo lockfile, và thời gian phát hành cảnh báo khi hồi quy 10%.
- Dọn dẹp agent không còn nhầm các phép chiếu nhóm Lead là worker con, nên việc hủy một runtime khác không thể đóng cuộc hội thoại desktop đang hoạt động hay bỏ một tin nhắn tiếp theo đã được chấp nhận.

## v0.9.130 - 2026-08-14

- Khôi phục nhà cung cấp và phiên giờ phân loại các lỗi luồng tạm thời nhất quán, thử lại các lượt bị từ chối vì hình ảnh mà không mất ý định của người dùng, và giữ trạng thái gián đoạn, tóm tắt và kết quả cuối qua các đường truyền Gemini và OpenAI.
- Lỗi công cụ được lưu mà không bị nhiễm dấu vết kiểm thử, chính sách shell tránh dương tính giả với script có dấu nháy, và các đường tìm kiếm/đọc/liệt kê/stat gốc dùng chung công việc có thể hủy trong khi giữ vô hiệu hóa watcher mới và hành vi grep/glob tệp chính xác dưới tải.
- Studio, mức dùng, hoạt động agent, bố cục ngăn, bản địa hóa và cách trình bày thẻ worker trên desktop giờ vẫn đồng bộ qua các phiên đã khôi phục và trực tiếp.

## v0.9.129 - 2026-08-14

- Exec headless giờ chạy một bề mặt solo thực sự theo mặc định: các công cụ tìm kiếm web và ghi nhớ vẫn tắt trừ khi --web-search / --memory bật lại, các tiến trình con của shell thừa hưởng một proxy không ra ngoài được thực thi (loopback vẫn truy cập được), và dòng môi trường của phiên nêu network=offline để mô hình không bao giờ thử truy cập web.

## v0.9.128 - 2026-08-14

- Các công cụ thăm dò giờ kết thúc ở vòng tìm kiếm: grep dùng ngân sách đầu ra cho các khối nguồn đã xếp hạng (kết quả khớp nhánh hiếm trước), find bỏ các kết quả mờ chỉ là nhiễu, và các outline ký hiệu code_graph lọc trước khi giới hạn và tôn trọng yêu cầu nội dung.
- Hướng dẫn agent gộp một lệnh gọi định tuyến tốt nhất cho mỗi ẩn số thay vì tản nhiều công cụ theo phỏng đoán, cắt giảm một phần ba mức dùng token của benchmark mà không đổi tỷ lệ vượt.
- Củng cố khôi phục phiên và độ bền runtime qua tìm kiếm gốc, hợp đồng shell và công cụ read/list.

## v0.9.127 - 2026-08-14

- Các tệp nhị phân gốc giờ có một nơi chuẩn duy nhất trong GitHub Releases: npm chỉ phát hành CLI, trong khi các lần chạy CLI xác minh và lưu đệm asset theo yêu cầu và các bản dựng Desktop nhúng cùng các asset nền tảng đã xác minh.

## v0.9.126 - 2026-08-14

- Tìm kiếm gốc giờ xử lý toàn bộ hợp đồng grep/find nội bộ, giữ các lỗi khôi phục regex, và chồng lấn việc khởi động trước tìm kiếm lượt đầu và code-graph.

## v0.9.125 - 2026-08-13

- Thực thi shell và tác vụ nền giờ dùng một trình quản lý tiến trình gốc được ghim hash trên Windows, Linux và macOS, không còn phương án dự phòng môi trường, bản dựng cục bộ, sổ đăng ký tệp, shell chờ hay tiến trình Node.
- Các đường tìm kiếm, patch, tải xuống, media, recall, webhook và phiên gốc giờ thực thi tài nguyên có giới hạn, quyền sở hữu chặt hơn, và các kiểm tra truyền tải và chuỗi cung ứng phát hành được củng cố.
- Việc giải nén runtime ghi nhớ giờ chấp nhận các liên kết trong kho lưu trữ đã xác minh trong khi vẫn từ chối duyệt ngược, liên kết ngoài và các mục tar đặc biệt.
- Hành vi dự án, terminal, cập nhật, ghép nối từ xa, relay và ngăn trên desktop giờ gồm các bản sửa bảo mật, khôi phục và bố cục đáp ứng đã hợp nhất.

## v0.9.124 - 2026-08-12

- Hoạt động agent trên desktop giờ nhóm mọi phiên đang hoạt động độc lập với tab đang focus, trong khi các ngăn phiên đã khôi phục khởi động trước đúng cách và các phiên hiện có nhận đầu vào tiếp theo mà không chờ host xác nhận.
- Truyền tải phiên desktop và daemon giờ sống sót qua các race khởi động, phiên điều khiển cũ, mất socket tạm thời và khôi phục luồng tại chỗ trong khi giữ quyền sở hữu từ xa toàn cục qua các lần đổi focus phiên.
- Tùy chọn commit Git giờ tách ví dụ hiển thị khỏi hướng dẫn AI, tuần tự hóa các lần lưu chồng lấn, và xác thực rồi chỉnh đầu ra Conventional Commit trước khi chấp nhận nó.
- Ghi nhớ cốt lõi giờ phản chiếu ngữ cảnh được tuyển chọn và được tạo vào một tệp nguyên tử có bảo vệ bản sửa đổi để các phiên có thể nạp ghi nhớ theo phạm vi mà không khởi động nguội runtime ghi nhớ, với các thay đổi làm mới bản phản chiếu.
- Neo bản ghi hội thoại TUI và xử lý vùng chọn Escape tránh các cú nhảy thị giác và khôi phục hàng đợi ngoài ý muốn, trong khi dự phòng từ chối của Terminal-Bench theo lý do chấm dứt của runtime ngay cả sau lời dẫn được phát.

## v0.9.123 - 2026-08-12

- Thiết lập nhà cung cấp trên desktop giờ khôi phục các phiên điều khiển cũ mà không để lộ các lỗi truyền tải thô, và lịch sử prompt chỉ hoạt động từ một bản nháp trống.
- Tìm kiếm đường dẫn tránh các lần quét toàn cây nguội, gộp các lần khởi động trước của watcher, và siết chặt thời hạn tìm kiếm gốc, đồng thời hàng loạt và ảnh chụp tiến trình.
- Hướng dẫn thời gian chờ shell bất đồng bộ giờ phân biệt công việc nền không giới hạn với các thời hạn buộc dừng tường minh.

## v0.9.122 - 2026-08-11

- Các quy tắc định tuyến công cụ giờ tập trung hóa quy ước đường dẫn, bỏ hướng dẫn gộp lô trùng lặp, và chỉ yêu cầu kiểm tra chỉ-đọc khi bằng chứng đang gặp rủi ro.
- Kiểm tra trước benchmark Anthropic giờ phân giải đúng các import nhà cung cấp từ các snapshot harness tạm cô lập.

## v0.9.121 - 2026-08-11

- Các quy tắc thực thi công cụ và chẩn đoán shell giờ phân biệt các lần trượt đường dẫn có kết luận, tin cậy các phong bì đã xác minh, giữ các kiểm tra giá trị trong cùng lượt, và nêu các sự kiện command-not-found từ stderr.
- Ảo hóa bản ghi hội thoại desktop giờ ghim các đầu mút chọn văn bản gốc trong khi tự cuộn khi kéo, còn các trình khởi chạy tiện ích căn biểu tượng và chữ trong các hàng có kích thước theo nội dung.

## v0.9.120 - 2026-08-11

- Các tác vụ shell nền giờ giữ phiên chủ sở hữu và daemon của chúng sau khi mọi chế độ xem tách ra, nên việc loại bỏ khi nhàn rỗi không thể hủy tác vụ trước khi hoàn tất của nó được giao.

## v0.9.119 - 2026-08-11

- Các bản dựng tái lập Native Graph và Token giờ chạy song song trên các runner độc lập, trong khi các lần tải lên DMG và ZIP macOS Intel chồng lấn và bỏ nhanh các lần truyền bị đình trệ.
- Điều hướng dự án trên desktop, các bề mặt tiện ích, focus bản ghi hội thoại và hành vi ảo hóa đã vendor được tinh chỉnh cùng với kiểu thực thi công cụ chặt hơn và tái sử dụng tiến trình hệ thống tệp.
- Xử lý tệp đính kèm Discord và Telegram giữ việc giao media có giới hạn và xác thực trực tiếp hành vi tải lên Telegram.

## v0.9.118 - 2026-08-11

- Desktop hợp nhất Agent, Tìm kiếm và Quản lý mã nguồn trong dock tiện ích, giữ Tiện ích được chọn trong khi khởi chạy công cụ, và căn cách xử lý cảnh báo so với lỗi trên các thẻ công cụ đã khôi phục và trực tiếp.
- Liệt kê tệp và tìm kiếm gốc giờ gộp việc liệt kê đồng thời, hỗ trợ các yêu cầu bền vững có thể hủy và ảnh chụp tiến trình, và giữ hành vi dự phòng có giới hạn dưới tải hệ thống tệp lớn.
- Gộp lô code-graph, tái sử dụng PowerShell chờ sẵn sàng, theo dõi cây tiến trình shell và vô hiệu hóa cache được củng cố trước công việc đồng thời và trạng thái cũ.

## v0.9.117 - 2026-08-11

- Gửi prompt trên desktop giờ hỗ trợ xếp hàng ngay bằng Enter và khôi phục chính xác bằng Esc văn bản và tệp đính kèm đang chờ, trong khi cuộn bản ghi hội thoại trì hoãn các hiệu chỉnh virtualizer khi người đọc đang chuyển động.
- Tiện ích trên desktop giờ trình bày các trình khởi chạy trực tiếp Studio, Terminal và Trình khám phá với mô tả được bản địa hóa, trong khi thanh hoạt động dùng nhận diện Tiện ích sáng tạo và cách trình bày mức dùng được làm mới.
- Các hành động kênh đã lỗi thời hướng tới mô hình và hạ tầng điều phối nhà cung cấp của chúng bị loại bỏ để danh mục công cụ được quảng bá khớp với bề mặt runtime.
- Hướng dẫn thực thi công cụ siết chặt bằng chứng gộp lô và xác minh trong cùng lượt, trong khi các đợt dồn hệ thống tệp, graph, patch và shell đồng thời có thêm xử lý threadpool, làn sinh tiến trình và áp lực khả năng tiếp cận có giới hạn.

## v0.9.116 - 2026-08-11

- Phân tích vòng Terminal-Bench H5 thêm các dấu vết tác vụ được thưởng và số vòng tổng hợp cho so sánh cuối cùng ở mức nỗ lực cao.

## v0.9.115 - 2026-08-11

- Phân tích vòng Terminal-Bench H4 ghi lại các thăm dò tác vụ thành công ở mức nỗ lực cao và nhịp truy xuất, vá và xác minh của chúng.
- Hướng dẫn thực thi công cụ giờ coi các sự kiện tác vụ và các kiểm tra đã chứng minh là trạng thái đã biết bền vững và giữ xác minh patch trong cùng lượt thực thi.

## v0.9.114 - 2026-08-11

- Danh tính công cụ được đoán giờ được xác minh trước các lệnh gọi phụ thuộc, kèm phân tích vòng Terminal-Bench H3 ghi lại các mẫu truy xuất kết quả.

## v0.9.113 - 2026-08-11

- Hướng dẫn công cụ giờ gộp lô các mẫu bằng chứng riêng biệt và tránh kích hoạt công cụ trì hoãn hoặc dự án dư thừa, với phân tích vòng Terminal-Bench ghi lại các mẫu thăm dò nối tiếp còn lại.

## v0.9.112 - 2026-08-11

- Các bề mặt tiện ích, hoạt động, bản ghi hội thoại, cài đặt và kho trên desktop được đơn giản hóa quanh cấu hình tính năng tập trung và các hồi quy gọn.
- Khôi phục nhà cung cấp, chẩn đoán shell/list và xác minh phát hành được hợp nhất thành các suite quan trọng-khi-phát-hành nhỏ hơn mà không làm yếu hợp đồng truyền tải, asset hay đóng gói của chúng.

## v0.9.111 - 2026-08-11

- Điều hướng kho giờ dùng trực tiếp bề mặt công cụ tích hợp mà không có agent khám phá riêng, giảm chi phí định tuyến và cấu hình cũ.
- Các quyết định thử lại WebSocket OpenAI giữ các lỗi xác thực, giới hạn tốc độ và hủy hiện tại, trong khi khôi phục truyền tải phiên và khử trùng lặp hoàn tất được củng cố.
- Gộp lô công cụ, tản graph, báo cáo tiến độ, và hành vi bản ghi hội thoại, cài đặt và dock tiện ích trên desktop được tinh gọn với các hồi quy tập trung.
- Hồ sơ Terminal-Bench 2.1, các lần chạy có thể tiếp tục, snapshot harness bất biến và tính chi phí được siết chặt cho các so sánh gốc có thể tái lập.

## v0.9.110 - 2026-08-11

- Các truyền tải nhà cung cấp giờ giới hạn các lần đình trệ không-stream của Anthropic, phân biệt lỗi truyền tải có thể thử lại với từ chối của mô hình, giữ tính liên tục suy luận của OpenAI khi khôi phục, và khởi động trước các phiên WebSocket tương thích.
- Các công cụ patch, list và shell khôi phục các lệch đường dẫn hoặc ngữ cảnh duy nhất trong một lệnh gọi trong khi vẫn giữ các bảo vệ về mơ hồ, liên kết tượng trưng và lệnh phá hủy.
- Hoàn tất tiêu đề phiên và xử lý dự phòng nguồn Markdown bền vững hơn, với các hồi quy tập trung về nhà cung cấp, renderer, công cụ và định tuyến.
- Chẩn đoán Terminal-Bench 2.1, các baseline gốc công bằng, tính mức dùng và các thí nghiệm phát lại suy luận có thể tái lập được mở rộng.

## v0.9.109 - 2026-08-10

- Các lệnh shell hoàn tất với mã thoát khác không giờ được coi là kết quả lệnh thay vì lỗi công cụ, với trạng thái runtime và TUI nhất quán.
- Định tuyến công cụ, giới hạn khám phá, hợp đồng kiểu đầu ra và các suite hồi quy của chúng được siết chặt để tránh công việc dư thừa trong khi giữ các báo cáo ngắn gọn hướng tới người dùng.
- Gốc patch gọn giờ thiết lập cả ranh giới ghi lẫn hệ tọa độ đường dẫn tương đối, kể cả hướng dẫn khôi phục rõ ràng hơn.

## v0.9.108 - 2026-08-10

- Phân tích patch gọn chấp nhận các lớp bọc Begin/End cũ quanh các phần gọn trong khi để nguyên đầu vào V4A chuẩn.

## v0.9.107 - 2026-08-10

- Các phiên tự động hóa và benchmark không tương tác giờ tường minh dùng ngữ cảnh phê duyệt ngầm định, trong khi các quy trình tương tác giữ cổng phê duyệt của người dùng.

## v0.9.106 - 2026-08-10

- Các client MCP, khám phá công cụ, hướng dẫn, thực thi, làm mới trì hoãn và tháo dỡ được cô lập theo phạm vi runtime để các máy chủ cùng tên không thể rò rỉ qua các phiên đồng thời hoặc agent độc lập.

## v0.9.105 - 2026-08-10

- Truy cập từ xa chỉ còn là ứng dụng web: gói Capacitor/Android đã loại bỏ, các route tải APK, hook vỏ gốc và việc nối phiên bản phát hành di động bị gỡ bỏ, trong khi triển khai relay có thêm một bước chuẩn bị renderer tường minh.
- Các lệnh gọi công cụ giờ chuẩn hóa đầu vào dự án hiện tại thành đường dẫn tương đối gọn, từ chối các phạm vi không khớp hoặc dư thừa một cách nhất quán, và giữ tính tương đương giữa các hợp đồng công cụ shell, patch, graph, explore và tích hợp.
- Báo cáo ngữ cảnh tách mức dùng nhìn thấy bởi nhà cung cấp khỏi áp lực thu gọn và dự trữ đã cấu hình, trong khi chế độ suy nghĩ thích ứng của Anthropic để chế độ hiển thị cho API trừ khi người vận hành ghi đè tường minh.
- Các bản nháp tác vụ mới giữ tab dự án riêng của chúng khi chọn hoặc đăng ký một dự án, và các thay đổi Fast thành công của phiên gieo cho bản nháp khớp kế tiếp mà không thay một lựa chọn mô hình khác.

## v0.9.104 - 2026-08-09

- Định tuyến công cụ giờ định vị các tọa độ kho chưa biết một lần, gán mỗi khía cạnh bằng chứng cho một công cụ chuyên dụng, chỉ gộp lô các lệnh gọi độc lập, và giữ các chỉnh sửa văn bản và xác minh sau rào cản thực thi patch.
- Kiểm tra thư mục hiển thị tệp dotfile và siêu dữ liệu tệp mà không cần thăm dò bằng Shell, trong khi các quy trình không ủy quyền bỏ bản giao việc Lead không dùng và dùng một bề mặt công cụ nhỏ hơn, khớp khả năng.

## v0.9.103 - 2026-08-08

- Điều hướng, ô soạn thảo, Studio, cài đặt và bản ghi hội thoại trên desktop giờ dùng chung một bố cục đáp ứng chặt hơn, với việc theo dõi cuộn ảo mạnh hơn, xử lý tệp cục bộ và phạm vi kiểm thử hồi quy DOM được mở rộng.
- Renderer từ xa được phát hành như một ứng dụng web có thể cài đặt với manifest ổn định, biểu tượng và service worker chỉ-mạng, trong khi relay phục vụ các asset đó với các content type manifest và service-worker cần thiết.
- Thực thi Solo không còn mang các định nghĩa agent lỗi thời về debugger, tác vụ bộ lập lịch hay trình xử lý webhook và loại bỏ giao thức route/cache cũ của chúng, giữ các dịch vụ tích hợp tách biệt khỏi các agent tùy chỉnh có thể chỉnh sửa.
- Tạo ảnh Codex được lưu trữ tường minh chọn công cụ ảnh cho các mô hình được hỗ trợ, với phạm vi kiểm thử nội dung yêu cầu tập trung.

## v0.9.102 - 2026-08-08

- Nâng phiên bản bảo trì; không có thay đổi chức năng so với v0.9.101.

## v0.9.101 - 2026-08-08

- Escape giờ gọi lại các tin nhắn đã xếp hàng, chưa xử lý vào ô soạn thảo trước mọi thứ khác — thứ tự hàng đợi trước — nên một lần Esc giữa lượt chỉnh sửa tin nhắn tiếp theo đang chờ thay vì ngắt lượt; lần nhấn thứ hai vẫn hủy.
- Quy trình là các định nghĩa phong cách làm việc thuần túy: các gói không còn mang danh sách agent. Mọi agent đã định nghĩa (tích hợp và tùy chỉnh) đều khả dụng cho bất kỳ quy trình ủy quyền nào, Solo vẫn không ủy quyền qua `delegation: none`, và xóa một agent tùy chỉnh gỡ nó khỏi mọi bề mặt cùng lúc, kể cả sinh theo tên.
- Cài đặt → Chung có thêm các công tắc độc lập Tìm kiếm web, Trình khám phá và Ghi nhớ; Ghi nhớ giờ kiểm soát các công cụ ghi nhớ/recall cùng việc chèn ghi nhớ cốt lõi, trong khi các chu kỳ ghi nhớ nền chuyển sang Ngữ cảnh như một công tắc riêng.
- Các lần chạy vai trò headless và phiên bench bắt đầu với khám phá, tìm kiếm web và ghi nhớ tắt (bề mặt cổ điển) và bật lại theo từng lần chạy qua cờ hoặc biến MIXDOG_FEATURE_*.
- Chính sách công cụ chung bỏ vòng xác minh bắt buộc sau chỉnh sửa, lấy bằng chứng rẻ nhất đủ dùng cho mỗi tra cứu, và định nghĩa explore là tìm kiếm nguồn thuần túy trên cây nguồn và tệp với một mục tiêu cụ thể cho mỗi truy vấn.

## v0.9.100 - 2026-08-07

- Kiểu dáng lệnh Ngữ cảnh không còn phụ thuộc vào việc mở Cài đặt trước hay va chạm với lớp context toàn cục của Monaco, và việc gắn lại bản ghi hội thoại không còn hoàn tác một chuyển động bánh xe nhỏ của người đọc.
- Các trình đóng gói desktop giờ khôi phục các lần tải npm bằng khóa cache chỉ-phụ-thuộc, nên các dấu phiên bản phát hành không khởi động nguội mọi lần cài nền tảng.
- Các bản nháp ẩn được coi là công việc có thể tiếp tục thay vì các bản phát hành đã xuất bản, ngăn các bản phát hành thất bại tiêu tốn thêm một phiên bản vá.

## v0.9.99 - 2026-08-07

- Kiểu chữ bản ghi hội thoại desktop giờ tách nội dung, trạng thái vận hành và siêu dữ liệu thành một thứ bậc ổn định hơn, trong khi Fast dùng một biểu tượng trạng thái gọn.
- Truy xuất của trình khám phá giờ tản mọi khía cạnh định vị cụ thể một lần, giữ nguyên văn các đường dẫn trả về, và dừng khôi phục có giới hạn thay vì trả về một neo yếu hoặc được dựng lại.
- Việc đọc danh mục mô hình đồng bộ không còn khởi chạy một yêu cầu mạng toàn cục ngầm định. Khởi động trước phiên vẫn là chủ sở hữu duy nhất của I/O danh mục từ xa, nên các truyền tải do nhà cung cấp chèn vào vẫn kín trên một bản cài nguội.
- Làn phát hành cô lập giờ chuẩn bị một runtime code-graph gốc đã xác minh một cách tường minh thay vì dựa vào một tệp nhị phân môi trường do job trước để lại.
- Các asset phát hành macOS Intel dùng các lần tải lên HTTP/1.1 có giới hạn, từng tệp một, kèm kiểm tra hoàn tất từ xa và thử lại, ngăn một lần truyền CLI bị đình trệ giữ toàn bộ bản phát hành vô thời hạn.
- Khôi phục bản phát hành cùng phiên bản chưa xuất bản giờ gộp các ghi chú đã tích lũy của nó vào phiên bản đó trước khi xuất bản thay vì để công việc đã phát hành bị đánh dấu là Unreleased.

## v0.9.98 - 2026-08-07

- Ghép nối trình duyệt từ xa giờ thiết lập một kênh mã hóa đầu cuối đã xác thực trước khi bất kỳ trạng thái phiên, dữ liệu terminal hay payload RPC nào có thể đi qua relay; các làn media không mã hóa vẫn đóng.
- Tệp đính kèm trên desktop giữ danh tính và siêu dữ liệu tệp qua ranh giới phiên, với trích xuất ảnh/PDF có giới hạn và chuẩn hóa media dùng chung cho đầu vào nhà cung cấp.
- Hướng dẫn làm quen trên desktop và văn bản cài đặt liên quan được bản địa hóa trên mọi ngôn ngữ đã phát hành, trong khi soạn IME, theo dõi bản ghi hội thoại ảo và các điều khiển chế độ nhanh hoạt động nhất quán trong các ngăn chạy lâu.
- Khôi phục phiên, giao tin nhắn đang chờ, lưu đệm danh mục nhà cung cấp, tạo tiêu đề, snapshot worktree và chỉ số runtime có giới hạn được siết chặt quanh dịch vụ phiên hợp nhất.
- Xác thực phát hành được chia thành các làn song song, biên dịch desktop chồng lấn với các cổng, các runtime đã chuẩn bị được lưu đệm, và các gói nền tảng tải lên một bản nháp ẩn duy nhất trước khi xuất bản nguyên tử. Các phụ thuộc chỉ dành cho renderer không còn bị nhân đôi trong kho lưu trữ desktop, giảm bộ cài Windows khoảng một phần ba.

## v0.9.97 - 2026-08-07

- Giao thức phiên 1 giờ mang một chỉ mục tương thích tường minh, cho phép các client mới hơn từ chối các daemon cũ hơn trong khi các client cũ hơn có thể gắn vào qua bề mặt tương thích được hỗ trợ mà không cần các ngăn xếp engine/backend song song.
- Các luồng desktop, terminal, kênh, OAuth và ghi nhớ giờ dùng chung daemon phiên hợp nhất toàn máy; các truyền tải engine/backend lỗi thời, phương án dự phòng và lớp tương thích đã bị loại khỏi nhánh phát triển.
- Các cổng quyền sở hữu phiên và khối lượng công cụ giờ điều phối công việc shell, patch, read, code-graph, ghi nhớ và kênh song song với việc tiếp nhận công bằng, ít I/O trùng lặp hơn, và phạm vi hủy/khôi phục mạnh hơn.
- Focus đa ngăn trên desktop, kéo tab, trạng thái xem lại, thông báo, đặt tên nhà cung cấp, chẩn đoán trình cập nhật và đóng gói cập nhật cho nhà phát triển được siết chặt, với các bài kiểm thử hồi quy renderer và truyền tải phiên mở rộng.
- Các lệnh tái tạo Terminal-Bench và xác thực chi phí giờ trỏ tới đúng lần chạy đã lưu trữ và thất bại rõ ràng khi bộ thử nghiệm được yêu cầu không có.

## v0.9.96 - 2026-08-07

- Kỷ luật phát hành giờ yêu cầu mọi gói ứng dụng được nâng phiên bản trước khi giao thức đường truyền của engine thay đổi, giữ các phiên bản workspace đồng bộ, và xuất bản danh tính đang chờ đó mà không tăng lần thứ hai ngoài ý muốn.
- Các bề mặt phát triển và đã cài tiếp tục dùng chung kho dữ liệu và xác thực hiện có; kỷ luật giao thức/phiên bản ngăn lệch daemon cùng phiên bản mà không giấu thông tin xác thực sau một hồ sơ mới.
- Xác thực phát hành giờ chặn việc đóng gói nền tảng và loại bỏ một lần chạy code-graph trùng lặp, tránh năm job đóng gói tốn kém khi một cổng tập trung thất bại.
- Xung đột giao thức trên desktop giờ giải thích đường khôi phục cập nhật/đóng-và-mở-lại thay vì hiện một ngoại lệ truyền tải phiên thô.
- Daemon giao thức-1 hợp nhất loại bỏ host phiên desktop trùng lặp, khôi phục hành vi kết nối lại/đồng bộ lại của daemon, và giữ công việc công cụ đã hoàn thành qua các ranh giới hết thời gian và hủy.

## v0.9.95 - 2026-08-06

- Một tiến trình toàn máy sở hữu mọi phiên đang chạy, và TUI terminal cùng mọi cửa sổ desktop gắn vào như các chế độ xem qua truyền tải HTTP+SSE 127.0.0.1, nên không có vai trò chủ sở hữu/người xem nào cần thương lượng giữa các bề mặt.
- Các prompt đã gửi không còn có thể bị mất giữa các bề mặt. Lần gửi của một chế độ xem daemon giữ câu trả lời đồng bộ nhưng được thử lại cho đến khi engine nhận (và giao lại sau khi daemon khởi động lại), lần gửi live-share được chủ sở hữu xác nhận và quay về spool bền vững khi bị từ chối hoặc không được xác nhận, và hàng đợi bỏ một id gửi được giao lại thay vì đăng tin nhắn hai lần.
- Chỉnh sửa đa client: tiếp tục một phiên mà chế độ xem khác đang giữ sẽ nhận engine trực tiếp đó thay vì nạp một bản sao thứ hai, các khung engine tản tới mọi chế độ xem, và một engine chỉ kết thúc cùng chế độ xem CUỐI CÙNG của nó — nên một terminal và một cửa sổ desktop có thể cùng điều khiển một phiên từng lượt một.

## v0.9.94 - 2026-08-05

- Thanh tab desktop co các tab cùng nhau về các mức sàn đang hoạt động/không hoạt động với mọi tab đều hiển thị thay vì cuộn, và các vỏ cảm ứng thu gọn thành một danh sách chuyển đổi tiêu đề + số lượng.
- Markdown đang phát chữa phần đuôi trực tiếp (`**`, `` ` ``, `~~` chưa đóng) và giới hạn khóa hình học mã có rào trong chunk riêng của nó, nên tiêu đề, danh sách và chữ đậm được định dạng trong khi mô hình vẫn đang gõ.
- Xem lại lượt chuyển vào dòng thời gian cuộn (diff lượt đi cùng luồng), chấm dứt việc dịch chuyển chồng ô soạn thảo khi vào phiên; các thông báo sắc cảnh báo giờ dùng cặp trạng thái hổ phách thay vì cặp trung tính.
- Dải chú thích gốc trong suốt để thanh tiêu đề DOM và lớp phủ hộp thoại làm mờ nó trực tiếp; cặp chuyển ngăn ◀ ▶ bị loại bỏ (Alt+Left/Right giữ vòng focus) và các hộp thoại dự án giữ quyền làm mờ thanh tiêu đề.
- Chụp giao diện desktop điều khiển Tác vụ mới và Cài đặt qua Ctrl+N / Ctrl+,, ghim ngôn ngữ chụp, và khẳng định bố cục cài đặt hẹp 360px.
- Tinh chỉnh cửa sổ bản ghi hội thoại TUI và harness jitter, cộng với các thăm dò race chọn phiên trên desktop.

## v0.9.93 - 2026-08-04

- Kiểm toán phụ thuộc về không trên core và desktop: `npm audit fix` cho fast-uri, ip-address, hono/@hono/node-server, undici gốc và brace-expansion; ghi đè undici lồng của discord.js được nâng lên 6.28.0; ghi đè `dompurify` của desktop `^3.4.12` xử lý lô XSS của Monaco.
- Kiểm toán tính năng README: mục workbench desktop, chi tiết hệ thống con ghi nhớ, ghép nối QR relay, cron giờ yên lặng và phiên âm Whisper cục bộ, các phiên ngăn song song, trình hướng dẫn làm quen.
- Discord: loại bỏ lệnh gạch chéo đã đăng ký cuối cùng (`/stop`); khởi động vẫn xóa các tập lệnh toàn cục/guild cũ.
- Terminal-Bench 2.1: kết quả đã sửa, các biểu đồ so sánh thay thế, và các script tái tạo/xác minh.
- CI: Deploy giờ là điểm vào phát hành duy nhất (chuỗi cung ứng token được gộp vào, cửa hậu push thẻ bị loại bỏ) với một cổng phát hành nhật ký thay đổi.
- Thống nhất phiên bản gói ở 0.9.92 (di động/relay đồng bộ) và nén lịch sử kho về một gốc sạch.

## v0.9.92 - 2026-08-02

- Bản phát hành cơ sở: gói npm, bộ cài desktop và các asset chuỗi cung ứng gốc (runtime, patch, graph, token, runtime giọng nói).
