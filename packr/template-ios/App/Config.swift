import UIKit

/// Values filled in by Packr when the project is generated.
/// Edit freely — this file is plain Swift, nothing regenerates it behind your back.
enum Config {
    static let appName = "__APP_NAME__"
    static let startURL = "__START_URL__"
    static let localMode = __LOCAL_MODE__
    static let localEntry = "__LOCAL_ENTRY__"
    static let externalLinksInBrowser = __EXTERNAL_LINKS_IN_BROWSER__
    static let pullToRefresh = __PULL_TO_REFRESH__
    static let allowZoom = __ALLOW_ZOOM__
    static let themeColorHex = "__THEME_COLOR__"

    static var themeColor: UIColor {
        var hex = themeColorHex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        var value: UInt64 = 0
        guard Scanner(string: hex).scanHexInt64(&value), hex.count == 6 else { return .black }
        return UIColor(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }

    /// Perceptual lightness of the theme colour, used to pick the status bar style.
    static var themeIsDark: Bool {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0
        themeColor.getRed(&red, green: &green, blue: &blue, alpha: nil)
        return (0.299 * red + 0.587 * green + 0.114 * blue) < 0.6
    }
}
