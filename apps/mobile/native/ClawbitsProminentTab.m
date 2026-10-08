#import <UIKit/UIKit.h>

// The previous build replaced UITabBarController.tabs during layout, which
// crashed on launch. The compose control is drawn beside the tab bar in JS.
@implementation UITabBarController (ClawbitsProminent)
@end
