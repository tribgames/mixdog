#import <Foundation/Foundation.h>
#import "User.h"
@import UIKit;
@import Foundation.NSString;

@interface User : NSObject
- (instancetype)initWithName:(NSString *)name;
- (NSString *)greet;
@property(nonatomic, copy) NSString *name;
@end

@implementation User
- (instancetype)initWithName:(NSString *)name {
  if ((self = [super init])) {
    _name = [name copy];
  }
  return self;
}

- (NSString *)greet {
  return [NSString stringWithFormat:@"hi %@", self.name];
}
@end

@protocol Renderable
- (NSString *)render;
@end

static int helper(int n) { return n + 1; }

int add(int a, int b) { return helper(a + b); }
